/**
 * LaneHeader — one `th.lane_header` of the card wall, with its WIP
 * limit (P-3; legacy cards/_header.rhtml + _wip_limit_info).
 *
 * Purpose: renders a lane's title and card count, and — when the wall
 * is a saved team grid favorite — the lane's WIP limit as
 * `count / limit` with an `over-limit` class once the lane holds more
 * cards than the limit, plus an inline set/clear form for viewers who
 * may edit the favorite. Pure presentation: the count and limit come
 * from the route's loader, the form posts the route's `wip` intent.
 * Extracted so the markup can be rendered and asserted on its own.
 *
 * Public interface: `LaneHeader`, `LaneHeaderProps`.
 * Owner context: Card Management (browser).
 */
import { Form } from "react-router";

export interface LaneHeaderProps {
  /** The lane's display title ("(not set)" for the unset lane). */
  title: string;
  /** The lane's stored value; "" for the unset lane, which never carries a limit. */
  laneValue: string;
  /** Cards currently in the lane. */
  count: number;
  /** The lane's WIP limit, or null when none is set. */
  limit: number | null;
  /** The team grid favorite whose limits are shown; null when the wall is not a saved favorite. */
  favoriteId: number | null;
  /** Whether the viewer may set limits (full team member on a saved team favorite). */
  editable: boolean;
}

/** One lane header cell; `over-limit` marks a lane holding more cards than its limit. */
export function LaneHeader({ title, laneValue, count, limit, favoriteId, editable }: LaneHeaderProps) {
  const overLimit = limit !== null && count > limit;
  const showsWip = favoriteId !== null && laneValue !== "";
  return (
    <th className={overLimit ? "lane_header over-limit" : "lane_header"} data-lane-value={laneValue}>
      <div className="header-title">
        {title}
        <span className="lane-card-number aggregate">{limit === null ? count : `${count} / ${limit}`}</span>
      </div>
      {showsWip ? (
        <div className="lane-wip">
          WIP : {limit === null ? "(not set)" : limit}
          {editable ? (
            <Form method="post" className="wip-limit-form">
              <input type="hidden" name="intent" value="wip" />
              <input type="hidden" name="favoriteId" value={favoriteId} />
              <input type="hidden" name="laneValue" value={laneValue} />
              <input type="number" name="limit" min={1} step={1} defaultValue={limit ?? ""} aria-label={`WIP limit for ${title}`} />
              <button type="submit">Set</button>
            </Form>
          ) : null}
        </div>
      ) : null}
    </th>
  );
}
