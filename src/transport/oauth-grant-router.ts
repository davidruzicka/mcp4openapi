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

    const allowed = new Set(['grant_type', ...definition.required, ...definition.optional]);
    for (const key of Object.keys(req.body as Record<string, unknown>)) {
      if (!allowed.has(key)) {
        throw new ValidationError(`Unsupported parameter '${key}' for grant_type '${grantType}'`);
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
