/* Who the interface greets.
 *
 * RoadLens has no accounts and no login — the API never returns a user, and
 * nothing here is a credential or a permission. This is a display name for the
 * top-bar chip and the dashboard greeting, nothing more, so it lives entirely
 * in the browser and defaults to the operator the install was set up for.
 *
 * `role` is a label, not an authorisation: every view is reachable by anyone
 * who can open the page. Do not grow this into an access check — that belongs
 * on the server, which currently has no notion of users at all.
 *
 * Change it from the console:  RoadLensProfile.set({ name: 'A. Sharma' })
 */

const KEY = 'roadlens-profile';

/* No account system means no real name to show, so the chip carries the role
   it is operated under rather than a person. `role` is optional and empty by
   default: "Admin" over "Administrator" is a stutter, not a subtitle. */
const DEFAULT = { name: 'Admin', role: '' };

/* localStorage throws in some privacy modes; a display name is never worth an
   exception, so both accesses are guarded — the same rule ui/theme.js uses. */
const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
};
const write = (v) => {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ }
};

/** @returns {{name, role, firstName, initials}} */
export function profile() {
  const saved = read();
  const name = (saved?.name || DEFAULT.name).trim() || DEFAULT.name;
  const role = (saved?.role ?? DEFAULT.role).trim();
  const parts = name.split(/\s+/);
  return {
    name,
    role,
    firstName: parts[0],
    // Two letters from the first and last word — one initial reads as a typo
    // in a filled circle, three crowds it.
    initials: (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : ''))
      .toUpperCase(),
  };
}

export function setProfile(patch) {
  const next = { ...profile(), ...patch };
  write({ name: next.name, role: next.role });
  window.dispatchEvent(new CustomEvent('profilechange'));
  return profile();
}

window.RoadLensProfile = { get: profile, set: setProfile };
