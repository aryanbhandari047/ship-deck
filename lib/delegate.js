'use strict';
// Delegation, deck side: a teammate with the `answer` grant answered a Needs-you item on the
// relay page. Each answer is checked here against this computer's own fleet and grants, then sent
// as the usual decision / backlog-answer order with answeredBy: at once when the captain asked
// that teammate for help with that item, else after a short window (5 s) in which the captain can
// cancel it. Runs in the server, so it works with no page open. No relay text is trusted: the
// target, the option and the teammate's access are all re-checked when the answer is sent.
const board = require('../public/board');

const DELAY_MS = 5000;
const RECENT_MS = 10 * 60e3;
const ASKING = ['needs-decision', 'blocked', 'failed'];

// "(B) option text" plus the reply, as the deck's own answer box writes it.
function answerText(opt, text) {
  if (!opt) return text;
  return `(${opt.letter}) ${opt.text}${text ? '\n\n' + text : ''}`;
}

// Why this answer must not be sent now, or null. target: agent.targetOf(...).
function refusal(a, target, canAnswer) {
  if (!target) return 'it no longer needs an answer';
  const item = target.type === 'task' ? target.t : target.b;
  if (target.type === 'task' && !ASKING.includes(item.state)) return 'it no longer needs an answer';
  if (board.guardedOf(item)) return 'only the captain can answer this';
  if (a.letter && !(item.options || []).some((o) => o.letter === a.letter)) return 'that option is no longer offered';
  if (!canAnswer(a.by, target.project)) return 'their access changed';
  return null;
}

// agent: the share agent. readTargets() -> { tasks, calls } (a fresh read of the home).
// send({ kind, target|item, option, text }, answeredBy) -> the order (server.js: createOrder + wake).
function createDelegation({ agent, readTargets, send, delayMs = DELAY_MS, now = Date.now, log = () => {} }) {
  const waiting = new Map(); // id -> { a, dueAt, timer, target }
  const busy = new Set();
  const recent = []; // [{ id, by, state, title, taskId, itemId, at, reason }]

  const where = (target) => (target ? { taskId: target.type === 'task' ? target.t.id : null, itemId: target.type === 'call' ? target.b.id : null } : { taskId: null, itemId: null });
  function remember(a, target, state, reason) {
    recent.unshift({ id: a.id, by: a.by, state, letter: a.letter, text: a.text, title: a.title, ...where(target), at: now(), reason: reason || null });
    recent.length = Math.min(recent.length, 20);
  }

  // Sends one answer if it is still current, else reports it refused.
  async function finish(a) {
    if (busy.has(a.id)) return;
    busy.add(a.id);
    try {
      const { tasks, calls } = await readTargets();
      const target = agent.targetOf(a.ref, tasks, calls);
      const why = refusal(a, target, agent.canAnswer);
      if (why) {
        remember(a, target, 'refused', why);
        await agent.markAnswer(a.id, 'refused', why);
        return;
      }
      const item = target.type === 'task' ? target.t : target.b;
      const opt = a.letter ? item.options.find((o) => o.letter === a.letter) : null;
      const body = target.type === 'task'
        ? { kind: 'decision', target: item.id, option: a.letter, text: answerText(opt, a.text) }
        : { kind: 'backlog-answer', item: item.id, option: a.letter, text: answerText(opt, a.text) };
      try {
        await send(body, a.by);
      } catch (e) {
        remember(a, target, 'refused', e.message);
        await agent.markAnswer(a.id, 'refused', e.message);
        return;
      }
      remember(a, target, 'sent');
      await agent.markAnswer(a.id, 'sent');
    } catch (e) {
      log('delegate: ' + e.message);
    } finally {
      busy.delete(a.id);
      waiting.delete(a.id);
    }
  }

  // New answers from the relay: asked ones go now, the rest wait out the cancel window.
  async function check() {
    const list = agent.pendingAnswers();
    if (!list.length) return;
    const { tasks, calls } = await readTargets();
    for (const a of list) {
      if (waiting.has(a.id) || busy.has(a.id)) continue;
      const target = agent.targetOf(a.ref, tasks, calls);
      // Not sendable, or asked for: settle it now (finish checks again).
      if (refusal(a, target, agent.canAnswer) || agent.askedFor(a.ref, a.by)) {
        await finish(a);
        continue;
      }
      const w = { a, target, dueAt: now() + delayMs, timer: null };
      w.timer = setTimeout(() => { if (waiting.get(a.id) === w) finish(a); }, delayMs);
      if (w.timer.unref) w.timer.unref();
      waiting.set(a.id, w);
    }
  }

  // The captain's Cancel: only while the window is open.
  async function cancel(id) {
    const w = waiting.get(id);
    if (!w || busy.has(id)) throw new Error('too late: it was already sent');
    clearTimeout(w.timer);
    waiting.delete(id);
    remember(w.a, w.target, 'cancelled');
    await agent.markAnswer(id, 'cancelled');
    return true;
  }

  // For the board: answers counting down, and what happened to recent ones.
  function view() {
    const t = now();
    return {
      waiting: [...waiting.values()].map((w) => ({ id: w.a.id, by: w.a.by, letter: w.a.letter, text: w.a.text, title: w.a.title, ...where(w.target), dueAt: w.dueAt })),
      recent: recent.filter((r) => r.at > t - RECENT_MS),
    };
  }

  return { check, cancel, view };
}

module.exports = { DELAY_MS, answerText, refusal, createDelegation };
