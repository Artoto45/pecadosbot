import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  VALID_LANGUAGES,
  isValidLanguage,
  reduceLanguageState,
  sanitizeLanguageState,
} from './language_adaptation.mjs';

const VALID_KINDS = new Set(['call', 'content']);
const DEFAULT_CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CONTACTS = 10_000;

function resolveDefaultTtlMs() {
  const raw = process.env.AUTOREPLY_CONVERSATION_TTL_SECONDS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_CONVERSATION_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_CONVERSATION_TTL_MS;
  return Math.max(0, parsed * 1000);
}

function fingerprint(namespace, value) {
  return crypto.createHash('sha256').update(`${namespace}\0${String(value)}`, 'utf8').digest('hex');
}

export class PersistentInteractionState {
  constructor({
    filePath,
    defaultLanguage = 'es',
    maxRecentEvents = 256,
    maxContacts = DEFAULT_MAX_CONTACTS,
    conversationTtlMs = null,
    now = () => Date.now(),
    logger = console,
  }) {
    if (!filePath) throw new TypeError('filePath is required');
    if (!isValidLanguage(defaultLanguage)) {
      throw new TypeError('defaultLanguage must be a valid language code');
    }
    if (!Number.isInteger(maxRecentEvents) || maxRecentEvents < 1) {
      throw new TypeError('maxRecentEvents must be a positive integer');
    }
    if (!Number.isInteger(maxContacts) || maxContacts < 1) {
      throw new TypeError('maxContacts must be a positive integer');
    }

    this.filePath = filePath;
    this.defaultLanguage = defaultLanguage;
    this.maxRecentEvents = maxRecentEvents;
    this.maxContacts = maxContacts;
    this.explicitTtl = conversationTtlMs !== null && conversationTtlMs !== undefined;
    this.conversationTtlMs = this.explicitTtl
      ? Math.max(0, Number(conversationTtlMs))
      : resolveDefaultTtlMs();
    this.now = now;
    this.logger = logger;
    this.contacts = {};
    this.aliases = {};
    this.load();
  }

  isConversationExpired(state, currentTime) {
    if (!state || !state.phase) return false;
    if (!Number.isFinite(this.conversationTtlMs) || this.conversationTtlMs <= 0) return false;
    const updatedAt = state.updated_at;
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
    if (!this.explicitTtl && updatedAt < 1_000_000_000 && currentTime >= 1_000_000_000) {
      return false;
    }
    return (currentTime - updatedAt) >= this.conversationTtlMs;
  }

  pruneContacts(keepKey = null) {
    const entries = Object.entries(this.contacts);
    if (entries.length <= this.maxContacts) return;
    const excess = entries.length - this.maxContacts;
    const candidates = entries
      .filter(([key, data]) => key !== keepKey && !data?.reset_pending)
      .sort((a, b) => (Number(a[1]?.updated_at) || 0) - (Number(b[1]?.updated_at) || 0));
    const removed = new Set(candidates.slice(0, excess).map(([key]) => key));
    for (const key of removed) {
      delete this.contacts[key];
    }
    if (removed.size > 0) {
      for (const [aliasKey, targetKey] of Object.entries(this.aliases)) {
        if (removed.has(targetKey) || !this.contacts[targetKey]) {
          delete this.aliases[aliasKey];
        }
      }
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed.contacts || typeof parsed.contacts !== 'object' || Array.isArray(parsed.contacts)) {
        throw new TypeError('contacts is not an object');
      }

      for (const [contactKey, raw] of Object.entries(parsed.contacts)) {
        if (!raw || typeof raw !== 'object' || ![0, 1, 2].includes(raw.phase)) continue;
        const resetPending = raw.reset_pending === true && raw.phase === 0;
        this.contacts[contactKey] = {
          phase: raw.phase,
          ...sanitizeLanguageState(raw),
          recent_events: !resetPending && Array.isArray(raw.recent_events)
            ? raw.recent_events.filter(item => typeof item === 'string').slice(-this.maxRecentEvents)
            : [],
          updated_at: Number.isFinite(raw.updated_at) ? raw.updated_at : 0,
          ...(resetPending ? { reset_pending: true } : {}),
        };
      }
      if (parsed.aliases && typeof parsed.aliases === 'object' && !Array.isArray(parsed.aliases)) {
        for (const [aliasKey, contactKey] of Object.entries(parsed.aliases)) {
          if (typeof contactKey === 'string' && this.contacts[contactKey]) {
            this.aliases[aliasKey] = contactKey;
          }
        }
      }
      this.pruneContacts();
    } catch {
      this.logger.error?.('[STATE] Interaction state could not be loaded; starting empty');
      this.contacts = {};
      this.aliases = {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify({ version: 2, contacts: this.contacts, aliases: this.aliases }),
        'utf8',
      );
      fs.renameSync(temporaryPath, this.filePath);
      return true;
    } catch {
      this.logger.error?.('[STATE] Interaction state could not be persisted');
      return false;
    }
  }

  register({
    contactId,
    contactAliases = [],
    eventId,
    kind,
    detectedLanguage = null,
    languageEvidence = null,
    provisionalLanguage = null,
  }) {
    if (contactId === undefined || contactId === null || contactId === '') {
      throw new TypeError('contactId is required');
    }
    if (eventId === undefined || eventId === null || eventId === '') {
      throw new TypeError('eventId is required');
    }
    if (!VALID_KINDS.has(kind)) throw new TypeError('kind must be call or content');
    if (!isValidLanguage(provisionalLanguage)) provisionalLanguage = null;

    const identityValues = [contactId, ...(Array.isArray(contactAliases) ? contactAliases : [])]
      .filter(value => value !== undefined && value !== null && value !== '');
    const identityKeys = [...new Set(identityValues.map(value => fingerprint('contact', value)))];
    const primaryKey = identityKeys[0];
    const eventKey = fingerprint('event', eventId);
    // Keep both a direct contact and its alias target. During the short PN/LID
    // convergence window both records may legitimately exist.
    const resolvedKeys = [...new Set(identityKeys.flatMap(key => [key, this.aliases[key]]))]
      .filter(key => typeof key === 'string');
    const existingKeys = resolvedKeys.filter(key => this.contacts[key]);
    const pendingResetKey = existingKeys.find(
      key => this.contacts[key].reset_pending === true && this.contacts[key].phase === 0,
    );
    const canonicalKey = pendingResetKey || existingKeys[0] || primaryKey;
    const states = existingKeys.map(key => this.contacts[key]);
    const pendingResetState = pendingResetKey ? this.contacts[pendingResetKey] : null;
    // A duplicate is observational: it must not merge identities, consume a
    // reset marker, advance a candidate, or rewrite aliases.
    const duplicateStates = pendingResetState ? [pendingResetState] : states;
    const duplicateState = duplicateStates.find(candidate => (
      Array.isArray(candidate.recent_events) && candidate.recent_events.includes(eventKey)
    ));
    if (duplicateState) {
      return {
        duplicate: true,
        phase: duplicateState.phase,
        responseKey: null,
        language: duplicateState.language || this.defaultLanguage,
        languageSource: duplicateState.language_source || null,
        languageCandidate: duplicateState.language_candidate || null,
        languageCandidateStreak: duplicateState.language_candidate_streak || 0,
        contactKey: canonicalKey,
        persisted: true,
      };
    }
    const state = pendingResetState || states[0] || {
      phase: 0,
      ...sanitizeLanguageState(null),
      recent_events: [],
      updated_at: 0,
    };

    // A pending panel reset is authoritative. Otherwise rank language sources
    // and break equal-rank conflicts by the newest state. Candidate streaks
    // are copied from at most one winner and are never added together.
    if (!pendingResetState) {
      for (const candidate of states.slice(1)) {
        state.phase = Math.max(state.phase, candidate.phase);
        const sourceRank = source => ({
          detected: 4, operator_seed: 3, legacy: 2, provisional: 1,
        }[source] || 0);
        if (candidate.language && (
          !state.language
          || sourceRank(candidate.language_source) > sourceRank(state.language_source)
          || (
            sourceRank(candidate.language_source) === sourceRank(state.language_source)
            && candidate.updated_at > state.updated_at
          )
        )) {
          Object.assign(state, sanitizeLanguageState(candidate));
        }
        state.updated_at = Math.max(state.updated_at, candidate.updated_at);
        state.recent_events = [...new Set([
          ...state.recent_events,
          ...candidate.recent_events,
        ])].slice(-this.maxRecentEvents);
      }
    }
    for (const oldKey of existingKeys) {
      if (oldKey !== canonicalKey) delete this.contacts[oldKey];
    }
    for (const [aliasKey, targetKey] of Object.entries(this.aliases)) {
      if (existingKeys.includes(targetKey)) this.aliases[aliasKey] = canonicalKey;
    }
    for (const identityKey of identityKeys) this.aliases[identityKey] = canonicalKey;
    this.contacts[canonicalKey] = state;

    Object.assign(state, reduceLanguageState(state, {
      detectedLanguage,
      languageEvidence,
      provisionalLanguage,
    }));
    const language = state.language || this.defaultLanguage;

    const currentTime = this.now();
    if (this.isConversationExpired(state, currentTime)) {
      state.phase = 0;
    }

    let responseKey;
    if (kind === 'call') {
      responseKey = 'call';
      state.phase = state.phase === 0 ? 1 : 2;
    } else if (state.phase === 0) {
      responseKey = 'step1';
      state.phase = 1;
    } else {
      responseKey = 'step2';
      state.phase = 2;
    }

    state.recent_events.push(eventKey);
    if (state.recent_events.length > this.maxRecentEvents) {
      state.recent_events.splice(0, state.recent_events.length - this.maxRecentEvents);
    }
    state.updated_at = currentTime;
    delete state.reset_pending;
    this.pruneContacts(canonicalKey);
    const persisted = this.save();

    return {
      duplicate: false,
      phase: state.phase,
      responseKey,
      language,
      languageSource: state.language_source || null,
      languageCandidate: state.language_candidate || null,
      languageCandidateStreak: state.language_candidate_streak || 0,
      contactKey: canonicalKey,
      persisted,
    };
  }
}
