import type { AccountConfig } from "../config/schema.js";

export class CredentialStore {
  public constructor(private readonly managedCredentials: Map<string, string>) {}

  public hasManagedCredential(accountId: string): boolean {
    return this.managedCredentials.has(accountId);
  }

  public resolve(accountId: string, accountConfig: AccountConfig): string | undefined {
    const managedCredential = this.managedCredentials.get(accountId);
    if (managedCredential) {
      return managedCredential;
    }

    return accountConfig.credential_env ? process.env[accountConfig.credential_env] : undefined;
  }
}
