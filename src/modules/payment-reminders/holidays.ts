/**
 * Bangladesh government public holidays used when "Treat public holidays as off days" is on.
 * 2026 follows the cabinet's official list (general + executive-order holidays). Moon-dependent
 * dates may move; update this file when the government revises them or publishes the 2027 list.
 * 2027 lists only the fixed-date national holidays until the official calendar is published.
 */
const HOLIDAYS: Record<string, string> = {
  "2026-02-04": "Shab-e-Barat",
  "2026-02-21": "Shaheed Day",
  "2026-03-17": "Shab-e-Qadr",
  "2026-03-19": "Eid ul-Fitr", "2026-03-20": "Eid ul-Fitr", "2026-03-21": "Eid ul-Fitr", "2026-03-22": "Eid ul-Fitr", "2026-03-23": "Eid ul-Fitr",
  "2026-03-26": "Independence Day",
  "2026-04-14": "Pahela Baishakh",
  "2026-05-01": "May Day · Buddha Purnima",
  "2026-05-26": "Eid ul-Adha", "2026-05-27": "Eid ul-Adha", "2026-05-28": "Eid ul-Adha", "2026-05-29": "Eid ul-Adha", "2026-05-30": "Eid ul-Adha", "2026-05-31": "Eid ul-Adha",
  "2026-06-26": "Ashura",
  "2026-08-05": "Mass Uprising Day",
  "2026-08-26": "Eid-e-Miladunnabi",
  "2026-09-04": "Janmashtami",
  "2026-10-20": "Durga Puja", "2026-10-21": "Durga Puja",
  "2026-12-16": "Victory Day",
  "2026-12-25": "Christmas Day",
  "2027-02-21": "Shaheed Day",
  "2027-03-26": "Independence Day",
  "2027-04-14": "Pahela Baishakh",
  "2027-05-01": "May Day",
  "2027-08-05": "Mass Uprising Day",
  "2027-12-16": "Victory Day",
  "2027-12-25": "Christmas Day",
};
export function bangladeshHoliday(dateKey: string): string | null {
  return HOLIDAYS[dateKey] ?? null;
}
