import type { Request, Response } from 'express';
import { ValidationError } from '../core/errors.js';

export type OAuthGrantHandler = (req: Request, res: Response) => Promise<void>;

interface GrantDefinition {
  required: string[];
  optional: string[];
  handler: OAuthGrantHandler;
}

export class OAuthGrantRouter {
  private readonly grants = new Map<string, GrantDefinition>();

  register(grantType: string, definition: GrantDefinition): void {
    this.grants.set(grantType, definition);
  }

  async route(req: Request, res: Response): Promise<void> {
    const grantType = typeof req.body?.grant_type === 'string' ? req.body.grant_type : undefined;
    if (!grantType) {
      throw new ValidationError('Missing grant_type');
    }
    const definition = this.grants.get(grantType);
    if (!definition) {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    // RFC 6749 §3.2: the token endpoint MUST ignore unrecognized request
    // parameters. Genuinely-unknown extras (e.g. audience) are ignored; only a
    // grant-defining parameter of a DIFFERENT grant is rejected, so a grant
    // cannot be confused by another grant's identifying parameter.
    const ownParams = new Set(['grant_type', ...definition.required, ...definition.optional]);
    const foreignGrantParams = new Set<string>();
    for (const [otherGrantType, otherDefinition] of this.grants) {
      if (otherGrantType === grantType) {
        continue;
      }
      for (const key of otherDefinition.required) {
        if (!ownParams.has(key)) {
          foreignGrantParams.add(key);
        }
      }
    }
    for (const key of Object.keys(req.body as Record<string, unknown>)) {
      if (foreignGrantParams.has(key)) {
        throw new ValidationError(`Parameter '${key}' is not valid for grant_type '${grantType}'`);
      }
    }

    for (const key of definition.required) {
      if (typeof req.body?.[key] !== 'string' || String(req.body[key]).trim() === '') {
        throw new ValidationError(`Missing ${key}`);
      }
    }
    await definition.handler(req, res);
  }
}
