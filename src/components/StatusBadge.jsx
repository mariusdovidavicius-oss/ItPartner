import { STATUS_COLOR_CLASSES, statusMeta } from "../lib/constants";

export default function StatusBadge({ list, value }) {
  const meta = statusMeta(list, value);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
        STATUS_COLOR_CLASSES[meta.color]
      }`}
    >
      {meta.label}
    </span>
  );
}
