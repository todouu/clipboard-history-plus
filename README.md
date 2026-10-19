# Gnome Clipboard History (fork)

Fork of [SUPERCILEX/gnome-clipboard-history](https://github.com/SUPERCILEX/gnome-clipboard-history),
a clipboard manager GNOME extension that saves what you've copied into an easily accessible,
searchable history panel. Upstream is itself a rewrite of
[Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator).
Licensed under MIT; original copyright notices are kept in `LICENSE`.

## Changes from upstream

- New shortcut `toggle-menu-at-pointer` ("Toggle the menu at mouse pointer", unset by default;
  set it in the extension settings). It opens the history panel anchored at the mouse pointer
  instead of the top bar.
- The pointer-anchored menu is height-capped to the larger free side of the pointer so it flips
  above/below the pointer instead of covering the whole work area.

Everything else is unchanged from upstream. The extension `uuid` is still
`clipboard-history@alexsaveau.dev`, so it cannot be installed side by side with the upstream
extension.

## Tips

- Open the panel from anywhere with <kbd>Super</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd>.
- Modify shortcuts in settings or delete them by hitting backspace while editing a shortcut.
- Use the `Only save favorites to disk` feature to wipe your non-favorited items on shutdown.
- Use `Private mode` to temporarily stop processing copied items.
- Use keyboard shortcuts while the panel is open:
  - <kbd>Ctrl</kbd> + <kbd>N</kbd> where `N` is a number from 1 to 9 to select the Nth
    non-favorited entry.
  - <kbd>Super</kbd> + <kbd>Ctrl</kbd> + <kbd>N</kbd> where `N` is a number from 1 to 9 to select
    the Nth favorited entry.
  - <kbd>Ctrl</kbd> + <kbd>p/n</kbd> to navigate to the previous/next page.
  - <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>S</kbd> to open settings.
  - <kbd>/</kbd> to search.
  - <kbd>F</kbd> to (un)favorite a highlighted item.
- Search uses case-insensitive [regex](https://regex101.com/?flavor=javascript).

## Install from source

Requires GNOME Shell 46 or newer (see `shell-version` in `metadata.json`), `git`, and
`glib-compile-schemas` (package `libglib2.0-bin` on Ubuntu/Debian).

This fork keeps the upstream `uuid` (`clipboard-history@alexsaveau.dev`), so the upstream extension
must not be installed at the same time. If you have it, disable and remove it first:

```shell
gnome-extensions disable clipboard-history@alexsaveau.dev
rm -rf ~/.local/share/gnome-shell/extensions/clipboard-history@alexsaveau.dev
```

(Extensions installed system-wide under `/usr/share/gnome-shell/extensions/` have to be removed
with your package manager instead.)

Install this fork:

```shell
git clone https://github.com/todouu/clipboard-history-plus.git \
  ~/.local/share/gnome-shell/extensions/clipboard-history@alexsaveau.dev
cd ~/.local/share/gnome-shell/extensions/clipboard-history@alexsaveau.dev
glib-compile-schemas schemas/
```

`schemas/gschemas.compiled` is a build artifact and is not committed, so the
`glib-compile-schemas` step is required; without it the extension fails to load its settings.

### Restart GNOME Shell

GNOME Shell only discovers newly installed extensions at startup:

- X11: press <kbd>Alt</kbd> + <kbd>F2</kbd>, type `r`, press <kbd>Enter</kbd>.
- Wayland: log out and back in.

### Enable

```shell
gnome-extensions enable clipboard-history@alexsaveau.dev
```

Then open the extension settings (`gnome-extensions prefs clipboard-history@alexsaveau.dev`) and
assign a key to "Toggle the menu at mouse pointer" if you want the pointer-anchored panel.

### Update

```shell
cd ~/.local/share/gnome-shell/extensions/clipboard-history@alexsaveau.dev
git pull
glib-compile-schemas schemas/
```

Then restart GNOME Shell as above. Re-run `glib-compile-schemas schemas/` whenever the schema XML
changes.
