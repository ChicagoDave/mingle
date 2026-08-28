/**
 * Murmur body renderer — turns the segments a murmur loader returns
 * into elements (Phase 20).
 *
 * Purpose: a murmur is stored as plain text and split server-side into
 * `MurmurSegment`s. This component renders them: text as text (React
 * escapes it, so a body can never inject markup), a `#123` reference
 * as a link to that card, and a resolved `@mention` as the token
 * highlighted. Nothing here decides WHAT links — that was settled when
 * the murmur was posted and stored — so a rendered murmur and the
 * `murmur_mentions` / `card_murmur_links` rows can never disagree.
 *
 * Public interface: `MurmurBody`.
 *
 * Owner context: Collaboration (presentation).
 */
import { Link } from "react-router";
import type { MurmurSegment } from "~/shared/wire-types";

export interface MurmurBodyProps {
  segments: MurmurSegment[];
  /** Project identifier, for building card links. */
  projectIdentifier: string;
}

/** Renders one murmur body from its server-computed segments. */
export function MurmurBody({ segments, projectIdentifier }: MurmurBodyProps) {
  return (
    <span className="murmur-body">
      {segments.map((segment, index) => {
        if (segment.kind === "text")
          return <span key={index}>{segment.text}</span>;
        if (segment.kind === "card")
          return (
            <Link
              key={index}
              className={`card-link-${segment.number}`}
              to={`/projects/${projectIdentifier}/cards/${segment.number}`}
            >
              #{segment.number}
            </Link>
          );
        return (
          <span key={index} className="at-highlight">
            @{segment.token}
          </span>
        );
      })}
    </span>
  );
}
