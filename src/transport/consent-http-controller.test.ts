/**
 * Unit tests for the browser-facing consent flow controller.
 *
 * Uses a minimal Express-Response double, so page rendering, fingerprint and
 * cookie binding, replay/expiry handling, and the pending-approval bound are
 * all testable without supertest or a listening server.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import {
  ConsentHttpController,
  CONSENT_APPROVAL_TTL_MS,
  CONSENT_COOKIE_NAME,
  PENDING_CONSENT_MAX,
} from './consent-http-controller.js';
import type { ConsentGateConfig } from '../types/profile.js';

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  status(code: number): MockResponse;
  type(value: string): MockResponse;
  send(body: unknown): MockResponse;
}

const makeRes = (): MockResponse => ({
  statusCode: 200,
  headers: {},
  body: '',
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  },
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  type() {
    return this;
  },
  send(body: unknown) {
    this.body = String(body);
    return this;
  },
});

const asResponse = (res: MockResponse): Response => res as unknown as Response;

const gate: ConsentGateConfig = {
  required: true,
  rules_version: 'v1',
  rules_summary: 'Accept the usage rules.',
  education_resource: 'https://rules.example/usage',
  identity_source: 'profile_oauth',
};

const oauthInput = (overrides: Record<string, string> = {}): Record<string, unknown> => ({
  response_type: 'code',
  client_id: 'client-1',
  redirect_uri: 'https://client.example/cb',
  scope: 'openid read',
  state: 's1',
  code_challenge: 'challenge',
  code_challenge_method: 'S256',
  ...overrides,
});

const cookieFromRender = (res: MockResponse): string => {
  const setCookie = res.headers['Set-Cookie'];
  expect(setCookie).toMatch(new RegExp(`^${CONSENT_COOKIE_NAME.replace(/[$-]/g, '\\$&')}=`));
  return setCookie.split(';')[0];
};

describe('ConsentHttpController', () => {
  describe('requestFingerprint', () => {
    it('is stable for identical input and distinct per field value and profile', () => {
      const controller = new ConsentHttpController();
      const base = controller.requestFingerprint('p1', oauthInput());

      expect(controller.requestFingerprint('p1', oauthInput())).toBe(base);
      expect(controller.requestFingerprint('p2', oauthInput())).not.toBe(base);
      expect(controller.requestFingerprint('p1', oauthInput({ redirect_uri: 'https://evil.example/cb' }))).not.toBe(base);
    });

    it('cannot be collided by values that shift field boundaries (canonical JSON encoding)', () => {
      const controller = new ConsentHttpController();
      // Under a naive `field=value&...` join, a value containing '&state=s2'
      // could impersonate a different request. JSON array encoding keeps every
      // field length-delimited, so the two fingerprints must differ.
      const smuggled = controller.requestFingerprint('p1', oauthInput({ scope: 'openid read&state=s2', state: '' }));
      const genuine = controller.requestFingerprint('p1', oauthInput({ scope: 'openid read', state: 's2' }));
      expect(smuggled).not.toBe(genuine);
    });
  });

  describe('approval lifecycle', () => {
    it('accepts a submission bound to the same fingerprint and browser cookie', () => {
      const controller = new ConsentHttpController();
      const fingerprint = controller.requestFingerprint('p1', oauthInput());
      const res = makeRes();
      controller.renderApprovalForm(asResponse(res), gate, oauthInput(), fingerprint);

      expect(controller.consumeApproval(fingerprint, cookieFromRender(res))).toBe(true);
    });

    it('rejects a replayed approval (one-time consumption)', () => {
      const controller = new ConsentHttpController();
      const fingerprint = controller.requestFingerprint('p1', oauthInput());
      const res = makeRes();
      controller.renderApprovalForm(asResponse(res), gate, oauthInput(), fingerprint);
      const cookie = cookieFromRender(res);

      expect(controller.consumeApproval(fingerprint, cookie)).toBe(true);
      expect(controller.consumeApproval(fingerprint, cookie)).toBe(false);
    });

    it('rejects a submission for a different fingerprint or with a wrong/missing cookie', () => {
      const controller = new ConsentHttpController();
      const fingerprint = controller.requestFingerprint('p1', oauthInput());
      const res = makeRes();
      controller.renderApprovalForm(asResponse(res), gate, oauthInput(), fingerprint);

      expect(controller.consumeApproval('other-fingerprint', cookieFromRender(res))).toBe(false);
      // The pending entry for `other-fingerprint` does not exist, the real one is untouched:
      expect(controller.consumeApproval(fingerprint, `${CONSENT_COOKIE_NAME}=wrong-browser`)).toBe(false);

      const res2 = makeRes();
      controller.renderApprovalForm(asResponse(res2), gate, oauthInput(), fingerprint);
      expect(controller.consumeApproval(fingerprint, undefined)).toBe(false);
    });

    it('rejects an approval after its TTL expired', () => {
      vi.useFakeTimers();
      try {
        const controller = new ConsentHttpController();
        const fingerprint = controller.requestFingerprint('p1', oauthInput());
        const res = makeRes();
        controller.renderApprovalForm(asResponse(res), gate, oauthInput(), fingerprint);
        const cookie = cookieFromRender(res);

        vi.setSystemTime(Date.now() + CONSENT_APPROVAL_TTL_MS + 1000);
        expect(controller.consumeApproval(fingerprint, cookie)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('evicts the oldest pending approval at PENDING_CONSENT_MAX instead of growing unbounded', () => {
      const controller = new ConsentHttpController();
      const pending = (controller as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals;
      const farFuture = Date.now() + CONSENT_APPROVAL_TTL_MS;
      for (let i = 0; i < PENDING_CONSENT_MAX; i += 1) {
        pending.set(`filler-${i}`, { browserId: 'b', expiresAt: farFuture });
      }

      const fingerprint = controller.requestFingerprint('p1', oauthInput());
      controller.renderApprovalForm(asResponse(makeRes()), gate, oauthInput(), fingerprint);

      expect(controller.pendingApprovalCount).toBe(PENDING_CONSENT_MAX);
      expect(pending.has('filler-0')).toBe(false);
      expect(pending.has(fingerprint)).toBe(true);

      // Re-rendering the same request reuses its slot and evicts nothing else.
      controller.renderApprovalForm(asResponse(makeRes()), gate, oauthInput(), fingerprint);
      expect(controller.pendingApprovalCount).toBe(PENDING_CONSENT_MAX);
      expect(pending.has('filler-1')).toBe(true);
    });
  });

  describe('page rendering', () => {
    it('escapes gate texts and OAuth field values in the approval form', () => {
      const controller = new ConsentHttpController();
      const hostileGate: ConsentGateConfig = {
        required: true,
        rules_version: 'v1<script>alert(1)</script>',
        rules_summary: '<script>alert("summary")</script>',
        education_resource: 'https://rules.example/"onmouseover="x',
        identity_source: 'profile_oauth',
      };
      const res = makeRes();
      controller.renderApprovalForm(
        asResponse(res),
        hostileGate,
        oauthInput({ state: '"><script>alert(2)</script>' }),
        'fp-escape',
      );

      expect(res.body).not.toContain('<script>');
      expect(res.body).toContain('&lt;script&gt;');
      expect(res.body).not.toContain('"onmouseover=');
      // No decorative CSRF token: protection is the fingerprint + __Host- cookie.
      expect(res.body).not.toContain('consent_token');
    });

    it('sets no-store and a restrictive CSP on every consent page, form-action only on the form', () => {
      const controller = new ConsentHttpController();

      const info = makeRes();
      controller.renderConsentInfo(asResponse(info), gate);
      const form = makeRes();
      controller.renderApprovalForm(asResponse(form), gate, oauthInput(), 'fp-csp');
      const expired = makeRes();
      controller.renderApprovalExpired(asResponse(expired), '/oauth/authorize?x=1');

      for (const res of [info, form, expired]) {
        expect(res.headers['Cache-Control']).toBe('no-store');
        expect(res.headers['Content-Security-Policy']).toContain("default-src 'none'");
        expect(res.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
        // Must override the transport-wide no-referrer: with no-referrer the
        // browser serializes the approval form POST's Origin header as "null",
        // which the origin validation rejects and the consent flow dies with
        // 403 "Origin not allowed". same-origin keeps the referrer internal
        // while letting the browser send the real Origin.
        expect(res.headers['Referrer-Policy']).toBe('same-origin');
      }
      expect(form.headers['Content-Security-Policy']).toContain("form-action 'self'");
      expect(expired.statusCode).toBe(400);
      expect(expired.body).toContain('Start the consent flow again');
    });

    it('escapes the retry URL on the expired page', () => {
      const controller = new ConsentHttpController();
      const res = makeRes();
      controller.renderApprovalExpired(asResponse(res), '/oauth/authorize?a="><script>alert(3)</script>');
      expect(res.body).not.toContain('<script>alert(3)');
    });

    it('returns 404 from the info page when the profile has no required consent gate', () => {
      const controller = new ConsentHttpController();

      const missing = makeRes();
      controller.renderConsentInfo(asResponse(missing), undefined);
      expect(missing.statusCode).toBe(404);

      const notRequired = makeRes();
      controller.renderConsentInfo(asResponse(notRequired), { ...gate, required: false });
      expect(notRequired.statusCode).toBe(404);
    });
  });

  describe('custom template and labels', () => {
    const template =
      '<!doctype html><html lang="cs"><head><style>body{color:red}</style><title>{{title}}</title></head>' +
      '<body><h1>Pravidla {{rules_version}}</h1><p>{{rules_summary}}</p><a href="{{education_resource}}">pravidla</a>' +
      '{{consent_body}}</body></html>';
    const templatedGate: ConsentGateConfig = { ...gate, template };

    it('renders all consent pages inside the custom template', () => {
      const controller = new ConsentHttpController();

      const info = makeRes();
      controller.renderConsentInfo(asResponse(info), templatedGate);
      expect(info.body).toContain('<style>body{color:red}</style>');
      expect(info.body).toContain('Pravidla v1');
      expect(info.body).toContain('Accept the usage rules.');
      expect(info.body).toContain('href="https://rules.example/usage"');
      expect(info.body).toContain('server-owned consent block');

      const form = makeRes();
      controller.renderApprovalForm(asResponse(form), templatedGate, oauthInput(), 'fp-1');
      expect(form.body).toContain('<style>body{color:red}</style>');
      expect(form.body).toContain('name="consent_accept"');
      expect(form.body).toContain('<form method="post">');

      const expired = makeRes();
      controller.renderApprovalExpired(asResponse(expired), '/retry', templatedGate);
      expect(expired.body).toContain('<style>body{color:red}</style>');
      expect(expired.body).toContain('Start the consent flow again');
    });

    it('keeps the security headers on templated pages (template cannot change the envelope)', () => {
      const controller = new ConsentHttpController();
      const form = makeRes();
      controller.renderApprovalForm(asResponse(form), templatedGate, oauthInput(), 'fp-1');
      expect(form.headers['Cache-Control']).toBe('no-store');
      expect(form.headers['Content-Security-Policy']).toContain("form-action 'self'");
      expect(form.headers['Set-Cookie']).toContain(CONSENT_COOKIE_NAME);
    });

    it('does not substitute placeholders inside request-derived values', () => {
      const controller = new ConsentHttpController();
      const form = makeRes();
      controller.renderApprovalForm(
        asResponse(form),
        templatedGate,
        oauthInput({ state: '{{rules_summary}}$&' }),
        'fp-1',
      );
      // The attacker-supplied placeholder survives verbatim (escaped), instead
      // of being expanded into profile content or regex replacement patterns.
      expect(form.body).toContain('{{rules_summary}}$&');
    });

    it('renders configured labels and substitutes the rules version inside the accept label', () => {
      const controller = new ConsentHttpController();
      const labeled: ConsentGateConfig = {
        ...gate,
        labels: { accept: 'Souhlasím s pravidly (verze {{rules_version}}) <&>', submit: 'Potvrdit souhlas' },
      };
      const form = makeRes();
      controller.renderApprovalForm(asResponse(form), labeled, oauthInput(), 'fp-1');
      expect(form.body).toContain('Souhlasím s pravidly (verze v1) &lt;&amp;&gt;');
      expect(form.body).toContain('<button type="submit">Potvrdit souhlas</button>');
      expect(form.body).not.toContain('I accept rules version');
    });

    it('falls back to the default labels when none are configured', () => {
      const controller = new ConsentHttpController();
      const form = makeRes();
      controller.renderApprovalForm(asResponse(form), gate, oauthInput(), 'fp-1');
      expect(form.body).toContain('I accept rules version v1');
      expect(form.body).toContain('Continue to sign in');
    });
  });
});
