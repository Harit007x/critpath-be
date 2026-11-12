import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "critpath-be";
export default defineRailway(() => {
  const critpathBe = service("critpath-be", {
    source: github("Harit007x/critpath-be", { branch: "main", checkSuites: false }),
    build: { buildCommand: "pnpm build", buildEnvironment: "V3", builder: "RAILPACK" },
    start: "node dist/index.js",
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    preDeploy: "pnpm db:deploy",
    replicas: { "ams": 1 },
    domains: [{ domain: "api.thecritpath.com", port: 5000 }],
  });

  return project("CritPath", {
    variables: { managed: false },
    resources: [critpathBe],
  });
});
