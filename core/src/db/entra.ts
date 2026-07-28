import {
  AzureCliCredential,
  ClientSecretCredential,
  InteractiveBrowserCredential,
  type TokenCredential,
} from "@azure/identity";
import { settingStr } from "./connectionSettings";
import type { ConnectionConfig } from "./types";

const SQL_SCOPE = "https://database.windows.net/.default";
/** Azure CLI's public client id — lets interactive auth work with no app registration (same trick as spike 3). */
const AZ_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const LOOPBACK_REDIRECT = "http://localhost:8400";

export type SecretProvider = (connectionId: string) => string | null;

/**
 * One credential per adapter lifetime: @azure/identity caches tokens internally, so
 * re-minting after expiry is silent (no second browser prompt for interactive).
 */
export function createCredential(cfg: ConnectionConfig, getSecret: SecretProvider): TokenCredential | null {
  const tenantId = settingStr(cfg, "tenantId");
  const clientId = settingStr(cfg, "clientId");
  switch (cfg.authType) {
    case "azure-cli":
      return new AzureCliCredential(tenantId ? { tenantId } : {});
    case "entra-interactive":
      return new InteractiveBrowserCredential({
        clientId: AZ_CLI_CLIENT_ID,
        tenantId: tenantId || "organizations",
        redirectUri: LOOPBACK_REDIRECT,
      });
    case "service-principal": {
      const secret = getSecret(cfg.id);
      if (!tenantId || !clientId || !secret) {
        throw new Error("Service principal auth requires tenant id, client id, and a stored client secret");
      }
      return new ClientSecretCredential(tenantId, clientId, secret);
    }
    case "sql-login":
    // LanceDB auth types never reach the MSSQL credential path.
    case "lancedb-cloud":
    case "lancedb-local":
    // Snowflake authenticates itself in its own adapter (password / JWT key-pair / external
    // browser). No Azure credential is involved, so this returns null the same way sql-login does.
    case "snowflake-password":
    case "snowflake-keypair":
    case "snowflake-oauth":
      return null;
  }
}

export async function mintSqlToken(credential: TokenCredential): Promise<string> {
  const token = await credential.getToken(SQL_SCOPE);
  if (!token) throw new Error("Failed to acquire Entra access token for Azure SQL");
  return token.token;
}
