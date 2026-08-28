/**
 * Collaboration — Atom serialization of the project history feed
 * (Phase 21).
 *
 * Purpose: renders `HistoryEntry` values as an Atom 1.0 document,
 * matching the shape legacy's `feeds/_feed.rxml` emitted: a feed-level
 * id, title, updated stamp and paging links, then one `<entry>` per
 * event carrying id, title, updated, author, category terms, a link to
 * the thing, and content.
 *
 * Every text value that reaches the document goes through `escapeXml`.
 * The document is BUILT from typed entries — no caller-supplied string
 * is ever concatenated in raw — which is the same generated-not-passed
 * -through discipline ADR-0011 fixed for page content, applied to a
 * second output format.
 *
 * Public interface: `ATOM_CONTENT_TYPE`, `renderAtomFeed`,
 * `AtomFeedContext`.
 *
 * Owner context: Collaboration. Pure — takes entries and context, and
 * returns a string; it never touches the database.
 */
import type { HistoryEntry } from "~/domain/history/read.server";

/** The content type an Atom document must be served as. */
export const ATOM_CONTENT_TYPE = "application/atom+xml; charset=utf-8";

/** What the feed needs beyond its entries. */
export interface AtomFeedContext {
  /** Absolute site root, no trailing slash, e.g. "https://mingle.example". */
  siteUrl: string;
  projectIdentifier: string;
  projectName: string;
  /** When the project itself was created — the feed's fallback stamp. */
  projectCreatedAt: Date;
  /** 1-based page this document represents. */
  page: number;
  /** Total pages available, at least 1. */
  totalPages: number;
}

/**
 * Escapes a value for XML text and attribute content.
 *
 * All five predefined entities are escaped rather than the minimum
 * three, so one function is correct in both positions and no caller has
 * to remember which context it is in.
 *
 * @param value - raw text
 * @returns text safe to place in an element body or a quoted attribute
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A simple element with escaped text content. */
function tag(name: string, text: string): string {
  return `<${name}>${escapeXml(text)}</${name}>`;
}

/** The canonical URL of one page of this feed. */
function feedUrl(ctx: AtomFeedContext, page: number): string {
  const base = `${ctx.siteUrl}/projects/${ctx.projectIdentifier}/feed.atom`;
  return page <= 1 ? base : `${base}?page=${page}`;
}

/** One `<entry>`. */
function entryXml(entry: HistoryEntry, ctx: AtomFeedContext): string {
  const parts = [
    // The entry id is a tag: URI rather than a URL — it must be stable
    // and globally unique, and it is not required to resolve. Basing it
    // on the trail plus source row id means an entry keeps its identity
    // even as it moves between pages.
    tag("id", `tag:${ctx.projectIdentifier},${entry.id}`),
    tag("title", entry.title),
    tag("updated", entry.occurredAt.toISOString()),
    `<author>${tag("name", entry.authorName)}</author>`,
    `<link rel="alternate" type="text/html" href="${escapeXml(
      `${ctx.siteUrl}${entry.href}`,
    )}"/>`,
    ...entry.categories.map(
      (term) => `<category term="${escapeXml(term)}"/>`,
    ),
    tag("content", entry.text ? `${entry.title} — ${entry.text}` : entry.title),
  ];
  return `<entry>${parts.join("")}</entry>`;
}

/**
 * Renders one page of history as an Atom 1.0 document.
 *
 * Paging follows legacy's reversed convention, which is worth stating
 * because it reads backwards: the feed runs newest-first, so `next`
 * points at the page of OLDER entries and `previous` at newer ones.
 * Legacy's own template carries the same note.
 *
 * @param entries - the page's entries, newest first
 * @param ctx - site URL, project identity, and paging position
 * @returns a complete Atom document
 */
export function renderAtomFeed(
  entries: HistoryEntry[],
  ctx: AtomFeedContext,
): string {
  const updated = entries[0]?.occurredAt ?? ctx.projectCreatedAt;
  const links = [
    `<link rel="current" href="${escapeXml(feedUrl(ctx, 1))}"/>`,
    `<link rel="self" href="${escapeXml(feedUrl(ctx, ctx.page))}"/>`,
    ...(ctx.page < ctx.totalPages
      ? [`<link rel="next" href="${escapeXml(feedUrl(ctx, ctx.page + 1))}"/>`]
      : []),
    ...(ctx.page > 1
      ? [
          `<link rel="previous" href="${escapeXml(
            feedUrl(ctx, ctx.page - 1),
          )}"/>`,
        ]
      : []),
  ];
  const head = [
    tag("id", feedUrl(ctx, 1)),
    tag("title", `${ctx.projectName} history`),
    tag("updated", updated.toISOString()),
    ...links,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    head.join(""),
    entries.map((entry) => entryXml(entry, ctx)).join(""),
    "</feed>",
  ].join("");
}
