export function initAvailability() {
    const el = document.getElementById("tz-label");
    if (!el) return;

    try {
        const tz = "America/Los_Angeles";
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            timeZoneName: "short",
            year: "numeric"
        }).formatToParts(new Date());
        const tzn = parts.find(p => p.type === "timeZoneName")?.value || "PT";

        let label = "PT";
        if (/PDT|PST/.test(tzn)) {
            label = tzn;
        } else {
            const off = new Intl.DateTimeFormat("en-US", {
                timeZone: tz,
                hour12: false,
                timeZoneName: "longOffset"
            }).formatParts(new Date()).find(p => p.type === "timeZoneName")?.value || "UTC-08:00";
            label = /-07:00/.test(off) ? "PDT" : "PST";
        }
        el.textContent = label;
    } catch {
        el.textContent = "PT";
    }
}
