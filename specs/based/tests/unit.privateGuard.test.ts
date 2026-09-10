// Traces: BASED-PRIVATE-GUARD
import { describe, expect, test } from "bun:test";
import { isPrivatePath } from "../../../scripts/check-private";

describe("BASED-PRIVATE-GUARD: paid and secret paths never enter this repo", () => {
  test("the paid product's directories are private", () => {
    expect(isPrivatePath("based-ai/src/index.ts")).toBe(true);
    expect(isPrivatePath("paid/README.md")).toBe(true);
    expect(isPrivatePath("private/notes.md")).toBe(true);
    expect(isPrivatePath("control-plane.private/x.ts")).toBe(true);
  });

  test("env files and private keys are private", () => {
    expect(isPrivatePath(".env")).toBe(true);
    expect(isPrivatePath(".env.production")).toBe(true);
    expect(isPrivatePath("core/.env.local")).toBe(true);
    expect(isPrivatePath("based_rsa_key.p8")).toBe(true);
    expect(isPrivatePath("certs/server.pem")).toBe(true);
    expect(isPrivatePath("certs/server.key")).toBe(true);
  });

  test("ordinary source and vendored files are not", () => {
    expect(isPrivatePath("core/src/server.ts")).toBe(false);
    expect(isPrivatePath("ui/vendor/lm-ag-ui/dist/index.js")).toBe(false);
    expect(isPrivatePath("docs/development.md")).toBe(false);
    expect(isPrivatePath("specs/based/tests/unit.privateGuard.test.ts")).toBe(false);
  });

  test("names that merely contain a private word are not", () => {
    expect(isPrivatePath("ui/src/components/PrivateBadge.tsx")).toBe(false);
    expect(isPrivatePath("docs/based-ai-roadmap.md")).toBe(false);
    expect(isPrivatePath("core/src/env.ts")).toBe(false);
  });

  test("windows separators are normalized", () => {
    expect(isPrivatePath("based-ai\\src\\index.ts")).toBe(true);
  });
});
