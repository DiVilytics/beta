// Centralized constants. Loaded before db.js so the Supabase client can pick
// up the credentials, and before any page script that needs paging or live-
// game persistence keys.

// ── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://qmeqdrzgsyiacwxjpdjk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtZXFkcnpnc3lpYWN3eGpwZGprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NzY3MDIsImV4cCI6MjA5MjQ1MjcwMn0.600_RzDrvlimAXLxNZrnzR1ieymPPwxavdkdM4h3wpU';

// ── PAGINATION ───────────────────────────────────────────────────────────────
// game-log and player profile both list game cards in batches of this size.
const PAGE_SIZE = 20;

// ── LIVE GAME PERSISTENCE ────────────────────────────────────────────────────
// Key under which an in-progress recorded game is parked in localStorage,
// and how long a snapshot stays valid before we discard it as stale.
const LIVE_GAME_KEY        = 'divilytics_live_game';
const LIVE_GAME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── STATIC DATA ──────────────────────────────────────────────────────────────
const DATA_OBJECTIVES_URL    = 'asset/data/objectives.json';
const DATA_FAQ_URL           = 'asset/data/faq.json';
const DATA_DECKS_URL         = 'asset/data/villain-decks.json';
// Card names per language; English has no file (the deck data is English).
const DATA_CARD_NAMES_URL    = 'asset/data/card-names.{lang}.json';
const DATA_BOX_INFO_URL      = 'asset/data/box-info.json';
// A character reprinted into another box (identical rules, not a [TAG]
// rework) without fragmenting its stats: name -> array of additional box
// names it also physically appears in, alongside its primary `characters.box`.
const DATA_CHARACTER_EXTRA_BOXES_URL = 'asset/data/character-extra-boxes.json';
