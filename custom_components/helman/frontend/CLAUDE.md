# Frontend agent notes

- This custom panel ships the built production bundle from `dist/helman-config-editor.js`.
- After any change that affects the frontend bundle (for example `src/**`, `package.json`, `vite.config.ts`, or frontend translations), run `npm run build` in this directory before committing.
- Commit the updated `dist/helman-config-editor.js` together with the source changes. Do not leave source-only frontend changes unbuilt.
