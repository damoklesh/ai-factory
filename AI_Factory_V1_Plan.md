# AI Factory V1 — plan de construcción para Codex

Fecha: 30/09/2026. Documento de especificación ligero, listo para entregar a Codex.

## 1. Objetivo y decisiones

Construir una automatización que implemente secuencialmente un pequeño backlog de GitHub Issues: seleccionar US, ejecutar Codex, abrir PR, comprobar CI, realizar revisión independiente, corregir si procede y fusionar antes de pasar a la siguiente US.

Steve mantiene la definición del producto, los criterios de aceptación y las decisiones excepcionales. El sistema automatiza la ejecución repetitiva.

V1: TypeScript + GitHub Actions + runner self-hosted Linux/WSL2 en el PC + Codex CLI autenticado con ChatGPT. Un repositorio privado piloto; una US activa; sin servidor permanente, base de datos, interfaz web ni API OpenAI obligatoria. IntelliJ es opcional. No usar exec-server ni mezclar esta solución con Agents API.

La autenticación de Codex y la de GitHub son independientes. El acceso de ChatGPT consume el cupo disponible de la cuenta: no equivale a uso ilimitado. Si falta cupo, detener y permitir reanudar, sin cambiar automáticamente a API de pago.

**Supuesto pendiente de comprobar:** no conocemos el sistema operativo ni las herramientas instaladas en el PC. Los pasos siguientes toman Windows + WSL2/Ubuntu como ejemplo; en Linux se omite WSL. Todo el entorno de automatización debe funcionar bajo el mismo usuario Linux.

## 2. Arquitectura

| Componente | Responsabilidad | Ubicación |
| --- | --- | --- |
| GitHub Issues | US, prioridad, dependencias y estado visible | GitHub |
| agent-orchestrator.yml | Arranque manual y ejecución del controlador | Repositorio / Actions |
| Orquestador TypeScript | Selección, transiciones, límites, verificación y merge | Proceso en el runner local |
| Codex Developer | Modificar código y proponer tests | Proceso CLI local |
| Codex Reviewer | Revisar diff y criterios con contexto nuevo | Otro proceso CLI local |
| ci.yml | Repetir build y pruebas sobre el commit de la PR | Runner independiente |
| Git/worktree | Aislar los cambios del directorio habitual de Steve | PC |

Developer y Reviewer son dos invocaciones separadas, no servicios. QA empieza con pruebas deterministas y smoke tests; un tercer agente queda para después.

Flujo: Start Sprint → seleccionar Issue → worktree → Developer → verificaciones locales → commit/push/PR → CI → Reviewer → corrección o merge → siguiente Issue.

La primera implementación utiliza **un controlador que espera el resultado del CLI y consulta GitHub con intervalos acotados**. No diseñar una coreografía de numerosos webhooks para la V1. Tras terminar o interrumpirse una ejecución, un nuevo Start Sprint reconcilia el estado existente.

Importante: no ejecutar el CI en el mismo y único runner ocupado esperando ese CI. Usar GitHub-hosted para CI, sujeto a los minutos/costes de la cuenta, o un segundo runner local realmente independiente. El mismo PC puede alojar dos runners, pero necesita recursos y aislar contenedores/puertos.

## 3. Estructura a generar dentro del repositorio piloto

```text
AGENTS.md
.github/workflows/agent-orchestrator.yml
.github/workflows/ci.yml
.github/ISSUE_TEMPLATE/agent-story.yml
automation/package.json
automation/package-lock.json
automation/tsconfig.json
automation/config.example.json
automation/src/orchestrator.ts
automation/src/codex.ts
automation/src/github.ts
automation/src/state.ts
automation/src/verify.ts
automation/prompts/developer.md
automation/prompts/reviewer.md
automation/schemas/developer-result.json
automation/schemas/review-result.json
automation/tests/
docs/automation-setup.md
```

Mantener el controlador en la rama base confiable. Nunca ejecutar una versión del orquestador modificada por la PR en revisión. Guardar logs fuera del worktree, ignorados por Git.

Configuración: rama base, etiqueta del runner, modelo opcional, comandos de validación, comandos smoke, checks CI requeridos, timeouts, máximo de historias por ejecución, máximo de correcciones y autoMerge.

Defaults: autoMerge=false, maxStories=1, maxFixCycles=3, timeout Codex=45 minutos, timeout CI=20 minutos, timeout workflow=180 minutos. Son límites iniciales configurables, no estimaciones de duración garantizada.

## 4. Contrato de las US y del estado

Usar Issues con etiqueta agent:ready y formato corto:

```markdown
## Objetivo
Como usuario quiero ... para ...
## Criterios de aceptación
- [ ] Caso normal observable
- [ ] Error o caso límite observable
## Alcance
Archivos/componentes previstos y exclusiones relevantes.
## Dependencias
Ninguna / #12, #15
## Prioridad
1
## Validación
Comandos o escenarios concretos; si se omiten, usar la configuración.
```

Seleccionar prioridad ascendente y luego número de Issue, con dependencias agent:done. Una Issue simplemente cerrada no certifica que su implementación haya sido fusionada. Validar campos; dependencias inexistentes, ambiguas o cíclicas bloquean selección.

Estados: READY → IMPLEMENTING → PR_OPEN → VERIFYING → REVIEWING → MERGED → DONE. Desvíos: FIXING, NEEDS_HUMAN, PAUSED_AUTH, PAUSED_QUOTA, FAILED_INFRA. Labels: agent:ready, agent:running, agent:blocked, agent:done; comentarios estructurados contienen issue, PR, rama, SHA revisado, ciclo y motivo.

GitHub conserva el estado recuperable. Los archivos locales son caché. Cada arranque consulta rama y PR existentes antes de crear nada. Usar rama estable agent/issue-<numero> y marcador en cuerpo de PR. Una repetición no debe generar otra PR ni marcar DONE prematuramente.

## 5. Ejecución y controles

1. Validar dependencias instaladas, autenticación, configuración y rama base.
2. Aplicar concurrency por repositorio, cancel-in-progress=false, y bloqueo local para evitar ejecuciones simultáneas.
3. Recuperar una US en curso; si no existe, seleccionar la siguiente elegible. Crear worktree desde la rama base actualizada, separado del checkout personal.
4. Invocar Codex con Node child_process.spawn y argumentos separados, sin concatenar texto de Issues en comandos shell. Prompt por stdin. Capturar eventos, stderr, exit code y resultado final.
5. Developer implementa y ejecuta pruebas. El controlador repite comandos configurados y comprueba cambios reales. El controlador crea commit, push y PR: estas operaciones no dependen de que el modelo afirme haberlas hecho.
6. Consultar la PR por API y esperar checks explícitamente requeridos para su head SHA. Checks ausentes, skipped o antiguos no son PASS.
7. Reviewer inicia contexto nuevo, recibe especificación, diff y resultados; produce JSON PASS/CHANGES_REQUESTED/NEEDS_HUMAN con hallazgos y evidencia. Su PASS es una evaluación del modelo, no una garantía.
8. Ante fallo funcional o de revisión, Developer corrige la misma rama y se repiten verificaciones para el nuevo SHA. Máximo tres ciclos de corrección totales por US, persistidos entre reanudaciones.
9. Solo fusionar si autoMerge=true, CI y review coinciden con el SHA actual, no hay bloqueo y se cumplen las reglas del repositorio. Usar la comprobación de SHA de la API de merge para evitar carreras.
10. Confirmar merged=true por GitHub, cerrar Issue con agent:done y seleccionar la siguiente. Si se exige aprobación humana de PR, mostrar el bloqueo y esperar sin eludir esa protección.

No permitir al Developer debilitar tests, thresholds, workflows, reglas ni el propio controlador para obtener PASS. Cambios necesarios en esos elementos requieren revisión humana. Conflictos de merge, decisiones funcionales ambiguas, migraciones destructivas o cambios de API incompatibles → NEEDS_HUMAN.

Docker smoke: proyecto Compose único por Issue, puertos independientes, esperar healthchecks con timeout, hacer HTTP real y limpiar únicamente los recursos propios en finally. No borrar volúmenes o contenedores personales.

Empezar con sandbox workspace-write; Docker, red y servicios pueden requerir permisos adicionales según plataforma. El doctor debe comprobarlos y reportar el bloqueo. No activar acceso total silenciosamente en el PC personal ni ignorar fallos de permisos.

## 6. Contrato CLI y autenticación

Codex soporta ejecución no interactiva, eventos JSONL, salida final con JSON Schema y reutilización de autenticación local. Ejemplo orientativo que el implementador debe validar con la versión instalada:

```bash
codex exec --sandbox workspace-write --json \
  --output-schema automation/schemas/developer-result.json \
  -o /tmp/developer-result.json -
```

El prompt entra por stdin. Un exit code cero no basta: validar schema, resultado, pruebas y estado GitHub. Distinguir error de autenticación/cupo de fallo del código. No reintentar indefinidamente.

Usar login ChatGPT bajo el usuario que ejecutará el runner. No subir auth.json a GitHub ni imprimirlo. La documentación oficial reserva esta ruta de autenticación CI a entornos confiables y advierte que no debe utilizarse con repositorios públicos/open source. Este plan adopta un repositorio privado y solo ejecuciones autorizadas por Steve.

Para GitHub, V1 usa un fine-grained PAT limitado al repositorio piloto, guardado como secret AGENT_GH_TOKEN. Permisos mínimos según llamadas implementadas: Contents, Pull requests e Issues read/write; Actions y Checks read. Evitar permisos de edición de workflows salvo necesidad explícita de bootstrap.

No asumir que GITHUB_TOKEN encadena automáticamente todos los eventos: las PR creadas con él pueden requerir aprobación de workflows y otros eventos no relanzan Actions. El PAT permite CI automático; una GitHub App es evolución posterior. El controlador conserva ese token y realiza operaciones GitHub; no incluirlo en prompts.

## 7. Fases y cinco US de construcción

| Fase / US | Resultado | Criterios de aceptación |
| --- | --- | --- |
| US1 — Base y doctor | Configuración, CLI, docs y diagnóstico | dry-run no modifica GitHub; doctor identifica tools/login/permisos faltantes sin revelar secretos |
| US2 — Una US a PR | Selector, worktree, Developer y publicación | Una Issue sencilla produce una PR verificable; relanzar reutiliza esa PR; directorio personal intacto |
| US3 — CI y review | Espera de checks y Reviewer independiente | CI rojo bloquea; resultado malformado bloquea; push posterior invalida review previa |
| US4 — Fix, merge y siguiente | Correcciones limitadas, reanudación y sprint | Con autoMerge activado fusiona dos US dependientes en orden; tres correcciones agotadas detienen |
| US5 — Actions y prueba real | Runner, workflow manual y guía rápida | Dos historias pequeñas completan flujo real; fallo simulado y reinicio no duplican trabajo |

Implementar en ese orden. Tests necesarios del controlador: selección/dependencias, reconciliación, límite de reintentos, checks por SHA, schema inválido y merge con SHA cambiado. Añadir modo mock para validar sin consumir Codex. La prueba real será en repo privado desechable o ramas piloto.

## 8. Pasos manuales de Steve

### A. Preparar la máquina

En Windows, instalar WSL2/Ubuntu si falta y Docker Desktop con integración WSL. En Linux, Docker Engine/Compose. Mantener el checkout Linux dentro de ~/projects, preferentemente fuera de /mnt/c.

Instalar Git, curl, GitHub CLI, Node LTS compatible con Codex y las herramientas del proyecto piloto. Para Spring: JDK 21 y Maven, o Maven Wrapper. Docker solo si el piloto requiere smoke/integración.

```bash
git --version
node --version
npm --version
gh --version
java -version
mvn -version
docker version
docker compose version
curl --version
npm install -g @openai/codex
codex --version
codex login
codex login status
gh auth login
gh auth status
```

Elegir login ChatGPT en Codex. Confirmar opciones con codex login --help si difieren. Probar primero un codex exec de solo lectura en un repositorio. Si Maven Wrapper existe, no hace falta instalar Maven global.

### B. Crear la rama de construcción

En un repositorio privado limpio, sustituir OWNER/REPO:

```bash
mkdir -p ~/projects
cd ~/projects
gh repo clone OWNER/REPO
cd REPO
git status
git switch main
git pull --ff-only
git switch -c chore/ai-factory-v1
```

Si la rama base no es main, sustituirla. Copiar este MD a docs/AI_Factory_V1_Plan.md y dar a Codex el prompt de la sección 10. Construir en esa rama, revisar y fusionar el bootstrap antes de ejecutar Actions: workflow_dispatch debe estar disponible en la rama por defecto.

### C. Registrar el runner

En GitHub: Settings → Actions → Runners → New self-hosted runner. Seleccionar Linux y arquitectura real. Ejecutar los comandos que GitHub genera, incluido el token temporal; no inventar ni guardar ese token en el repositorio.

Usar una carpeta separada, por ejemplo ~/actions-runner-ai, y etiqueta ai-local. Primera prueba en primer plano con ./run.sh. Después, si procede, instalar el servicio siguiendo GitHub; bajo WSL comprobar systemd y el usuario del servicio. Que el runner arranque no garantiza que WSL sobreviva al apagado o suspensión de Windows.

El workflow debe seleccionar [self-hosted, linux, ai-local]. Confirmar que el usuario efectivo ve Codex y su login. Instalar Java/Node en ese entorno, no solo en Windows o IntelliJ.

### D. Configurar GitHub

- Crear AGENT_GH_TOKEN como secret con el PAT indicado; fijar caducidad y renovar cuando expire.
- Permitir Actions y escoger el runner de CI independiente.
- Crear las etiquetas agent:* y definir los checks requeridos una vez conocidos sus nombres reales.
- Configurar reglas de rama acordes al modo elegido. No exigir aprobación humana si se pretende merge completamente automático; si se mantiene, el sistema se detendrá ahí.
- Crear dos Issues pequeñas, primero sin dependencias y la segunda dependiente de la primera. Marcar agent:ready.
- Primera ejecución: una historia, autoMerge=false. Revisar PR, logs y CI; después habilitar autoMerge para el piloto.

## 9. Arranque rápido y operación

El implementador debe proporcionar estos comandos npm:

```bash
cd automation
npm ci
npm run doctor
npm run test
npm run orchestrate -- --dry-run
npm run orchestrate -- --max-stories 1
```

Configurar los comandos de validación del piloto, por ejemplo ./mvnw -B clean verify y npm ci/npm test/npm run build según proyecto. No imponer herramientas de frontend a un backend puro.

Después: encender PC/WSL/Docker/runner → GitHub Actions → AI Factory → Run workflow → seleccionar límites y autoMerge.

Para detener, cancelar el workflow; el controlador debe terminar procesos hijos, conservar rama/PR y marcar estado recuperable. Para reanudar, relanzar Start Sprint. Para volver al trabajo manual, usar el checkout habitual; el agente tiene su worktree.

Un PC apagado no ejecuta jobs. Verificar estado y relanzar si un job pendiente expira. No prometer continuidad 24/7.

## 10. Prompt listo para construir

> Lee docs/AI_Factory_V1_Plan.md e implementa la V1 en la rama actual. Empieza inspeccionando el repositorio y las instrucciones existentes. Construye las cinco US en orden, con TypeScript y Codex CLI local; no añadas servidor, interfaz ni API OpenAI de pago. Genera el workflow manual, CI adaptado al proyecto, prompts, schemas, doctor, dry-run, tests del controlador y guía de setup. Verifica los flags de Codex instalados. Mantén las credenciales fuera del código y autoMerge desactivado por defecto. Completa lo posible en código sin requerir acceso a mi PC. Lista al terminar los pasos manuales pendientes y los comandos exactos. No registres runners, cambies reglas de GitHub ni actives automatización contra repositorios reales sin mi instrucción. Ejecuta tests y una simulación; distingue lo validado de lo que necesita el piloto real.

## 11. Referencias oficiales

Verificadas al preparar este plan; revisar durante implementación si cambian flags o permisos.

- Codex no interactivo y autenticación CI: https://developers.openai.com/codex/noninteractive
- Añadir runner: https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners
- Eventos y autenticación de workflows: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow

Las fases, contratos y controles anteriores son decisiones de diseño de esta V1, no funcionalidades que GitHub o Codex proporcionen automáticamente.
