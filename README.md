# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
bun x sv@0.15.2 create --template minimal --types ts --add tailwindcss="plugins:none" --install bun .
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Private AI Backend

The webapp exposes server-side API routes that proxy to the private Spark AI backend:

- `GET /api/ai/health`
- `POST /api/ai/ocr`
- `POST /api/ai/embeddings`

Configure the backend from the webapp server environment:

```sh
AI_BACKEND_URL=http://private-server-or-spark-proxy:8090
AI_BACKEND_API_KEY=change-me
```

`AI_BACKEND_URL` should be reachable from the deployed webapp server. It does not need to be reachable from browsers.

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
