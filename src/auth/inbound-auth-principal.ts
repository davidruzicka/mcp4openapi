export interface AuthorizedPrincipal {
  authType: 'oauth' | 'enterprise' | 'token';
  profileId: string;
  issuer?: string;
  subject: string;
  clientId?: string;
  scopes: string[];
  groups?: string[];
  tenantId?: string;
  expiresAt?: number;
  claimsHash?: string;
}

export interface InboundAuthTokenRecord {
  token: string;
  principal: AuthorizedPrincipal;
  issuedAt: number;
  expiresAt?: number;
}
