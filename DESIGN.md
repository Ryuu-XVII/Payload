# Payload design

Payload uses Material 3 structure with a quiet violet-tinted surface, Roboto, and a deep indigo primary action. Dark mode uses the same hierarchy with a light violet action. App icons supplied by the publisher carry each app’s identity.

On the library screen, the small Payload app bar gives way to the Library title. Updates lead with filled actions and explicit installed and available versions. Hairline dividers and a common icon, text, and action grid hold the list together. The catalog follows with tonal actions. Large fonts move actions below the row title when needed.

The app details screen gives the icon and name top billing, aligns versions and APK size in a simple facts list, and anchors the primary action and install status above the navigation inset. This same action area carries permission guidance, progress, confirmation, and retries. Release notes scroll independently of the action area.

Use 48 dp minimum touch targets, scalable type, Android ripple, system Back, and live announcements for meaningful state changes. Loading uses static skeleton rows. Empty and error states name the next action.
