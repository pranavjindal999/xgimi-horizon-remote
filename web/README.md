# Web page

This is the remote UI. The server builds and serves it.

```bash
npm install
npm run build
```

From the repo root, `npm run build` does the same thing, and `./scripts/install.sh` does both the server and this page.

`npm run dev` starts Vite and proxies `/api` and `/ws` to `http://127.0.0.1:8095`. Start the server first with `./scripts/run.sh`.
