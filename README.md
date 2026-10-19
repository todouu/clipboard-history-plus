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

Targets GNOME Shell 46+ (see `metadata.json`).

```shell
git clone https://github.com/todouu/clipboard-history.git \
  ~/.local/share/gnome-shell/extensions/clipboard-history@alexsaveau.dev
cd ~/.local/share/gnome-shell/extensions/clipboard-history@alexsaveau.dev
glib-compile-schemas schemas/
gnome-extensions enable clipboard-history@alexsaveau.dev
```

Then restart GNOME Shell: on X11 press <kbd>Alt</kbd> + <kbd>F2</kbd>, type `r`; on Wayland log out
and back in. Re-run `glib-compile-schemas schemas/` after changing the schema XML.
