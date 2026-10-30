'use strict';
// The team pool: skills and notes any account on this relay (the team) may offer, synced to every
// member's deck only after an approver (OWNER_EMAIL, plus POOL_APPROVERS) approves them. Pure
// functions; lib/app.js authenticates (deck tokens), stores, audits and routes.
//   pool    Redis hash: "index" (approved items without text), "i:<id>" (one item's text)
//   poolq   Redis hash: <id> -> one pending offer (with text), seen only by approvers and its author
//   pool:ver  bumped on approve and remove, read in the deck auth MGET (the knowledge version)
// Members read approved items through /v1/knowledge as the deck POOL_SUB, so their own decks write
// them as read-only teammate-* skills like any other shared knowledge.
const { randomId, sha256 } = require('../auth/tokens');

const POOL_SUB = 'team-pool';
const POOL_NAME = 'Team pool';
const MAX_ITEMS = 100;
const MAX_PENDING = 50;
const MAX_PER_PERSON = 10; // pending offers per author
const MAX_TEXT = 16000; // like a library item
const MAX_BODY = 32 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{6,16}$/;

const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const KINDS = ['skill', 'note'];

// An offer body -> { kind, title, description, text } (or throws on a shape a deck never sends).
function sanitizeOffer(body) {
  const it = body && typeof body === 'object' && body.v === 1 && body.item && typeof body.item === 'object' ? body.item : null;
  if (!it || !KINDS.includes(it.kind)) throw new Error('unsupported offer');
  const title = s(it.title, 120).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  const text = s(it.text, MAX_TEXT);
  if (!title || !text.trim()) throw new Error('an offer needs a title and text');
  return { kind: it.kind, title, description: s(it.description, 300), text };
}

// The knowledge key a member's deck sees for an approved item.
const keyOf = (item) => `${item.kind === 'skill' ? 'skill' : 'memory'}:pool:${item.id}`;
const newId = () => randomId(9);
const hashOf = (it) => sha256(JSON.stringify([it.title, it.description, it.text, it.by, it.approvedBy])).slice(0, 16);

// Who approves: the relay owner and anyone in POOL_APPROVERS.
function approvers(config) {
  const list = String(config.poolApprovers || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return new Set([config.ownerEmail, ...list].filter(Boolean));
}

// One hash over what members get; it changes when an item is approved, edited or removed.
function poolHash(index) {
  return sha256(JSON.stringify((index || []).map((i) => [i.id, i.h]))).slice(0, 32);
}

module.exports = { POOL_SUB, POOL_NAME, MAX_ITEMS, MAX_PENDING, MAX_PER_PERSON, MAX_TEXT, MAX_BODY, ID_RE, sanitizeOffer, keyOf, newId, hashOf, approvers, poolHash };
