type FocusPlaces<T> = { body: T; pressed: T | null; banner: T };

export const takesFocus = <T>(
  active: T | null,
  { body, pressed, banner }: FocusPlaces<T>,
): boolean =>
  active === null || active === body || active === pressed ||
  active === banner;

export type Confirmation = { sentWith: string | null } | null;

export const staysOpen = (opened: Confirmation, resetKey: string): boolean =>
  opened !== null &&
  (opened.sentWith === null || opened.sentWith === resetKey);
