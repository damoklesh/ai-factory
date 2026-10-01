# HOW-TO: primera implementación de una User Story

Guía rápida para arrancar AI Factory de forma local y ejecutar la primera historia del backlog.

## 1. Preparar el entorno

Requisitos: Node.js 22 o superior y npm.

```bash
npm ci
Copy-Item automation/config.example.json automation/config.json
```

Edita `automation/config.json` con el repositorio objetivo, su rama y la ruta del backlog. Mantén siempre:

```json
"autoMerge": false
```

Para que una historia pueda llegar al gate de merge, configura al menos un nombre en `requiredChecks` y asegúrate de que ese check existe en GitHub. No guardes tokens ni credenciales en Git; usa `AGENT_GH_TOKEN` o `GITHUB_TOKEN` sólo en el entorno local.

## 2. Arrancar la aplicación

```bash
npm run dev
```

Abre [http://127.0.0.1:3333](http://127.0.0.1:3333). Selecciona la carpeta local del proyecto objetivo y pulsa **Inspect and select**.

## 3. Ejecutar la primera historia

1. En **Backlog**, confirma que las historias son válidas y que la User Story elegida tiene sus dependencias completadas.
2. En **Project Doctor**, inspecciona la tecnología del proyecto; revisa cualquier plan de scaffold antes de aplicarlo.
3. En **Executions**, elige **Run selected story** (o la siguiente elegible) y pulsa **Start execution**.
4. Sigue los eventos y las validaciones. La UI indicará si Codex está ejecutándose, espera CI o necesita una decisión humana.
5. En **Human validation**, revisa SHA, checks y evidencia. Aprobar registra la decisión; no hace el merge.
6. Cuando todo esté validado, haz el merge manualmente en GitHub y pulsa **Refresh GitHub state** para que el controlador observe el merge.

## 4. Comprobaciones sin servicios externos

Para validar la instalación local:

```bash
npm run test:all
npm run orchestrate --prefix automation -- --mock --max-stories 1
```

El modo `--mock` no contacta con GitHub ni Codex. Para revisar una configuración sin ejecutar cambios, usa `--dry-run`.

