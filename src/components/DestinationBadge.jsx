import { prettifyDestination, UNCLASSIFIED } from "../lib/destination";

export default function DestinationBadge({ destination }) {
  const isUnclassified = !destination || destination === UNCLASSIFIED;
  return (
    <span
      className={`ml-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        isUnclassified
          ? "border-signal-red/30 bg-signal-red/10 text-signal-red"
          : "border-signal-orange/30 bg-signal-orange/10 text-signal-orange"
      }`}
    >
      {prettifyDestination(destination)}
    </span>
  );
}
