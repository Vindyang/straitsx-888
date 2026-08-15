import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 4002);
const app = buildApp({ logger: true });

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`policy-service listening on ${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
