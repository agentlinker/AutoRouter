import { useState } from "react";

import type { RouteOutcomeItem } from "../api/traces.js";
import { traceFailureAttribution, truncateTraceFailureText } from "../utils/traceFailureReason.js";
import { AppDialog } from "./Dialog.js";

export function TraceFailureReason(props: { item: RouteOutcomeItem }) {
  const [open, setOpen] = useState(false);
  const error = props.item.reason ?? "";
  const attribution = traceFailureAttribution(props.item);
  const errorPreview = truncateTraceFailureText(error);
  const attributionPreview = truncateTraceFailureText(attribution);
  const hasMore = errorPreview !== error || attributionPreview !== attribution;
  const reasonLabel = props.item.status === "filtered" ? "原因" : "报错";

  if (!error && !attribution) {
    return <>—</>;
  }

  return (
    <>
      <span className="trace-failure-part"><strong>{reasonLabel}：</strong>{errorPreview || "—"}</span>
      <span className="trace-failure-part"><strong>归因：</strong>{attributionPreview || "—"}</span>
      {hasMore ? (
        <button className="trace-failure-more" type="button" onClick={() => setOpen(true)}>more</button>
      ) : null}
      <AppDialog open={open} title="失败原因" onClose={() => setOpen(false)}>
        <div className="trace-failure-details">
          <p><strong>{reasonLabel}：</strong>{error || "—"}</p>
          <p><strong>归因：</strong>{attribution || "—"}</p>
        </div>
      </AppDialog>
    </>
  );
}
