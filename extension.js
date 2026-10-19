import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
  Extension,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

import * as Store from './store.js';
import * as DS from './dataStructures.js';
import { openConfirmDialog } from './confirmDialog.js';
import SettingsFields from './settingsFields.js';

const Clipboard = St.Clipboard.get_default();
const VirtualKeyboard = (() => {
  let VirtualKeyboard;
  return () => {
    if (!VirtualKeyboard) {
      VirtualKeyboard = Clutter.get_default_backend()
        .get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    return VirtualKeyboard;
  };
})();

const SETTING_KEY_CLEAR_HISTORY = 'clear-history';
const SETTING_KEY_PREV_ENTRY = 'prev-entry';
const SETTING_KEY_NEXT_ENTRY = 'next-entry';
const SETTING_KEY_TOGGLE_MENU = 'toggle-menu';
const SETTING_KEY_TOGGLE_MENU_AT_POINTER = 'toggle-menu-at-pointer';
const SETTING_KEY_PRIVATE_MODE = 'toggle-private-mode';
const INDICATOR_ICON = 'edit-paste-symbolic';
// Vertical space (logical px) kept free around the pointer-anchored menu.
const POINTER_MENU_MARGIN = 48;

const PAGE_SIZE = 50;
const MAX_VISIBLE_CHARS = 200;
const IMAGE_MIMETYPE = 'image/png';
// The mimetypes St.Clipboard.get_text() understands. If none is offered, the clipboard has no text.
const TEXT_MIMETYPES = [
  'text/plain;charset=utf-8',
  'UTF8_STRING',
  'text/plain',
  'STRING',
];
// Thumbnails are decoded at twice the logical size of .ci-image-thumbnail so they stay sharp on
// HiDPI screens.
const THUMBNAIL_WIDTH = 192;
const THUMBNAIL_HEIGHT = 96;
const THUMBNAIL_CACHE_SIZE = 100;

let MAX_REGISTRY_LENGTH;
let MAX_BYTES;
let WINDOW_WIDTH_PERCENTAGE;
let CACHE_ONLY_FAVORITES;
let MOVE_ITEM_FIRST;
let ENABLE_KEYBINDING;
let PRIVATE_MODE;
let NOTIFY_ON_COPY;
let CONFIRM_ON_CLEAR;
let MAX_TOPBAR_LENGTH;
let TOPBAR_DISPLAY_MODE; // 0 - only icon, 1 - only clipboard content, 2 - both, 3 - none
let DISABLE_DOWN_ARROW;
let STRIP_TEXT;
let PASTE_ON_SELECTION;
let PROCESS_PRIMARY_SELECTION;
let IGNORE_PASSWORD_MIMES;
let ENABLE_TYPEAHEAD_SEARCH;
let MAX_IMAGE_BYTES;
let MAX_IMAGE_CACHE_BYTES;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Signature, IHDR chunk length and type, then the IHDR width and height.
const PNG_HEADER_SIZE = 24;

/** Reads the dimensions from the IHDR chunk without decoding. Null if `bytes` isn't a PNG. */
function readPngDimensions(bytes) {
  if (bytes.get_size() < PNG_HEADER_SIZE) {
    return null;
  }

  const header = bytes.get_data().subarray(0, PNG_HEADER_SIZE);
  if (!PNG_SIGNATURE.every((byte, i) => header[i] === byte)) {
    return null;
  }
  if (String.fromCharCode(...header.subarray(12, 16)) !== 'IHDR') {
    return null;
  }

  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

class ClipboardIndicator extends PanelMenu.Button {
  _init(extension) {
    super._init(0, extension.indicatorName, false);

    this.extension = extension;
    this.settings = extension.getSettings();
    this._thumbnails = new Map();
    // Cancelled on destroy: stops thumbnail decoding and marks pending async callbacks as stale.
    this._cancellable = new Gio.Cancellable();

    this._shortcutsBindingIds = [];
    this._pointerAnchor = new St.Widget({
      width: 1,
      height: 1,
      opacity: 0,
      reactive: false,
    });
    Main.uiGroup.add_child(this._pointerAnchor);
    this._pointerAnchor.hide();

    const hbox = new St.BoxLayout({
      style_class: 'panel-status-menu-box clipboard-indicator-hbox',
    });
    this.icon = new St.Icon({
      icon_name: INDICATOR_ICON,
      style_class: 'system-status-icon clipboard-indicator-icon',
    });
    hbox.add_child(this.icon);
    this._buttonText = new St.Label({
      text: '',
      y_align: Clutter.ActorAlign.CENTER,
    });
    hbox.add_child(this._buttonText);
    this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
    hbox.add_child(this._downArrow);
    this.add_child(hbox);

    this._fetchSettings();
    this._buildMenu();
    this._updateTopbarLayout();
  }

  destroy() {
    this._disconnectSettings();
    this._unbindShortcuts();
    this._disconnectSelectionListener();
    this._cancellable.cancel();
    this._thumbnails.clear();

    if (this._searchFocusHackCallbackId) {
      GLib.Source.source_remove(this._searchFocusHackCallbackId);
      this._searchFocusHackCallbackId = undefined;
    }
    if (this._pasteHackCallbackId) {
      GLib.Source.source_remove(this._pasteHackCallbackId);
      this._pasteHackCallbackId = undefined;
    }

    this._pointerAnchor?.destroy();
    this._pointerAnchor = undefined;

    super.destroy();
  }

  _buildMenu() {
    this.searchEntry = new St.Entry({
      name: 'searchEntry',
      style_class: 'search-entry ci-history-search-entry',
      can_focus: true,
      hint_text: _('Search clipboard history…'),
      track_hover: true,
      x_expand: true,
      y_expand: true,
    });

    const entryItem = new PopupMenu.PopupBaseMenuItem({
      style_class: 'ci-history-search-section',
      reactive: false,
      can_focus: false,
    });
    entryItem.add_child(this.searchEntry);
    this.menu.addMenuItem(entryItem);

    this.menu.connect('open-state-changed', (self, open) => {
      if (open) {
        this._setMenuWidth();
        this._applyPointerMenuMaxHeight();
        this.searchEntry.set_text('');
        this._searchFocusHackCallbackId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          1,
          () => {
            global.stage.set_key_focus(this.searchEntry);
            this._searchFocusHackCallbackId = undefined;
            return false;
          },
        );
      } else {
        this._restoreMenuSource();
      }
    });
    // Hiding the anchor earlier unmaps BoxPointer's source actor mid-fade, which
    // skips repositioning and flashes the menu at the top-left corner.
    this.menu.connect('menu-closed', () => this._hidePointerAnchor());

    // Create menu sections for items
    // Favorites
    this.favoritesSection = new PopupMenu.PopupMenuSection();

    this.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
    const favoritesScrollView = new St.ScrollView({
      style_class: 'ci-history-menu-section',
      overlay_scrollbars: true,
    });
    favoritesScrollView.add_child(this.favoritesSection.actor);

    this.scrollViewFavoritesMenuSection.actor.add_child(favoritesScrollView);
    this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // History
    this.historySection = new PopupMenu.PopupMenuSection();

    this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
    this.historyScrollView = new St.ScrollView({
      style_class: 'ci-history-menu-section',
      overlay_scrollbars: true,
    });
    this.historyScrollView.add_child(this.historySection.actor);

    this.scrollViewMenuSection.actor.add_child(this.historyScrollView);

    this.menu.addMenuItem(this.scrollViewMenuSection);

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const actionsSection = new PopupMenu.PopupMenuSection();
    const actionsBox = new St.BoxLayout({
      style_class: 'ci-history-actions-section',
    });

    actionsSection.actor.add_child(actionsBox);
    this.menu.addMenuItem(actionsSection);

    const prevPage = new PopupMenu.PopupBaseMenuItem();
    prevPage.add_child(
      new St.Icon({
        icon_name: 'go-previous-symbolic',
        style_class: 'popup-menu-icon',
      }),
    );
    prevPage.connect('activate', this._navigatePrevPage.bind(this));
    actionsBox.add_child(prevPage);

    const nextPage = new PopupMenu.PopupBaseMenuItem();
    nextPage.add_child(
      new St.Icon({
        icon_name: 'go-next-symbolic',
        style_class: 'popup-menu-icon',
      }),
    );
    nextPage.connect('activate', this._navigateNextPage.bind(this));
    actionsBox.add_child(nextPage);

    actionsBox.add_child(new St.BoxLayout({ x_expand: true }));

    this.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
      _('Private mode'),
      PRIVATE_MODE,
      { reactive: true },
    );
    this.privateModeMenuItem.connect('toggled', () => {
      this.settings.set_boolean(
        SettingsFields.PRIVATE_MODE,
        this.privateModeMenuItem.state,
      );
    });
    actionsBox.add_child(this.privateModeMenuItem);
    this._updatePrivateModeState();

    const clearMenuItem = new PopupMenu.PopupBaseMenuItem();
    clearMenuItem.add_child(
      new St.Icon({
        icon_name: 'edit-delete-symbolic',
        style_class: 'popup-menu-icon',
      }),
    );
    actionsBox.add_child(clearMenuItem);

    const settingsMenuItem = new PopupMenu.PopupBaseMenuItem();
    settingsMenuItem.add_child(
      new St.Icon({
        icon_name: 'emblem-system-symbolic',
        style_class: 'popup-menu-icon',
      }),
    );
    settingsMenuItem.connect('activate', this._openSettings.bind(this));
    actionsBox.add_child(settingsMenuItem);

    if (ENABLE_KEYBINDING) {
      this._bindShortcuts();
    }
    this.menu.actor.connect('key-press-event', (_, event) =>
      this._handleGlobalKeyEvent(event),
    );

    Store.buildClipboardStateFromLog(
      (entries, favoriteEntries, nextId, nextDiskId) => {
        /**
         * This field stores the number of items in the historySection to avoid calling _getMenuItems
         * since that method is slow.
         */
        this.activeHistoryMenuItems = 0;
        /**
         * These two IDs are extremely important: making a mistake with either one breaks the
         * extension. Both IDs are globally unique within compaction intervals. The normal ID is
         * *always* present and valid -- it allows us to build an inverted index so we can find
         * previously copied items in O(1) time. The Disk ID is only present when we cache all
         * entries. This additional complexity is needed to know what the ID of an item is on disk as
         * compared to in memory when we're only caching favorites.
         */
        this.nextId = nextId;
        this.nextDiskId = nextDiskId || nextId;
        /**
         * DS.LinkedList is the actual clipboard history and source of truth. Never use historySection
         * or favoritesSection as the source of truth as these may get outdated during pagination.
         *
         * Entries *may* have a menuItem attached, meaning they are currently visible. On the other
         * hand, menu items must always have an entry attached.
         */
        this.entries = entries;
        this.favoriteEntries = favoriteEntries;

        this.currentlySelectedEntry = entries.last();
        this._restoreFavoritedEntries();
        this._maybeRestoreMenuPages();

        this._settingsChangedId = this.settings.connect(
          'changed',
          this._onSettingsChange.bind(this),
        );

        this.searchEntry
          .get_clutter_text()
          .connect('text-changed', this._onSearchTextChanged.bind(this));
        clearMenuItem.connect('activate', this._removeAll.bind(this));

        this._setupSelectionChangeListener();
      },
    );
  }

  _setMenuWidth() {
    const display = global.display;
    const screen_width = display.get_monitor_geometry(
      display.get_primary_monitor(),
    ).width;

    this.menu.actor.width = screen_width * (WINDOW_WIDTH_PERCENTAGE / 100);
  }

  _handleGlobalKeyEvent(event) {
    return (
      this._handleCtrlSelectKeyEvent(event) ||
      this._handleSettingsKeyEvent(event) ||
      this._handleNavigationKeyEvent(event) ||
      this._handleFocusSearchKeyEvent(event) ||
      this._handleSearchTypeAheadKeyEvent(event)
    );
  }

  _handleCtrlSelectKeyEvent(event) {
    if (!event.has_control_modifier()) {
      return;
    }

    const index = parseInt(event.get_key_unicode()); // Starts at 1
    if (isNaN(index) || index <= 0) {
      return;
    }

    const items =
      event.get_state() === 68 // Ctrl + Super
        ? this.favoritesSection._getMenuItems()
        : this.historySection._getMenuItems();
    if (index > items.length) {
      return;
    }

    this._onMenuItemSelectedAndMenuClose(items[index - 1]);
    return true;
  }

  _handleSettingsKeyEvent(event) {
    if (event.get_state() !== 12 || event.get_key_unicode() !== 's') {
      return;
    }

    this._openSettings();
    return true;
  }

  _handleNavigationKeyEvent(event) {
    if (!event.has_control_modifier()) {
      return;
    }

    if (event.get_key_unicode() === 'n') {
      this._navigateNextPage();
    } else if (event.get_key_unicode() === 'p') {
      this._navigatePrevPage();
    } else {
      return;
    }

    return true;
  }

  _handleFocusSearchKeyEvent(event) {
    if (event.get_key_unicode() !== '/') {
      return;
    }

    global.stage.set_key_focus(this.searchEntry);
    return true;
  }

  _handleSearchTypeAheadKeyEvent(event) {
    if (!ENABLE_TYPEAHEAD_SEARCH) {
      return false;
    }

    if (global.stage.get_key_focus() === this.searchEntry) {
      return false;
    }

    if (
      event.has_control_modifier() ||
      event.has_alt_modifier?.() ||
      event.has_super_modifier?.()
    ) {
      return false;
    }

    const keySymbol = event.get_key_symbol();
    if (keySymbol === Clutter.KEY_BackSpace) {
      const currentText = this.searchEntry.get_text();
      if (!currentText) {
        return false;
      }

      global.stage.set_key_focus(this.searchEntry);
      this.searchEntry.set_text(currentText.slice(0, -1));
      return true;
    }

    const unicode = event.get_key_unicode();
    if (!unicode || unicode.length !== 1) {
      return false;
    }

    const codePoint = unicode.charCodeAt(0);
    if (codePoint < 32 || codePoint === 127) {
      return false;
    }

    global.stage.set_key_focus(this.searchEntry);
    this.searchEntry.set_text(this.searchEntry.get_text() + unicode);
    return true;
  }

  _addEntry(entry, selectEntry, updateClipboard, insertIndex) {
    if (!entry.favorite && this.activeHistoryMenuItems >= PAGE_SIZE) {
      const items = this.historySection._getMenuItems();
      const item = items[items.length - 1];
      this._rewriteMenuItem(item, entry);
      this.historySection.moveMenuItem(item, 0);

      if (selectEntry) {
        this._selectEntry(entry, updateClipboard);
      }
      return;
    }

    const menuItem = new PopupMenu.PopupMenuItem('', { hover: false });
    menuItem.setOrnament(PopupMenu.Ornament.NONE);

    menuItem.entry = entry;
    entry.menuItem = menuItem;

    menuItem.connect(
      'activate',
      this._onMenuItemSelectedAndMenuClose.bind(this),
    );
    menuItem.connect('key-press-event', (_, event) =>
      this._handleMenuItemKeyEvent(event, menuItem),
    );

    this._setEntryLabel(menuItem);

    // Favorite button
    const icon_name = entry.favorite
      ? 'starred-symbolic'
      : 'non-starred-symbolic';
    const iconfav = new St.Icon({
      icon_name: icon_name,
      style_class: 'system-status-icon',
    });

    const icofavBtn = new St.Button({
      style_class: 'ci-action-btn',
      can_focus: true,
      child: iconfav,
      x_align: Clutter.ActorAlign.END,
      x_expand: true,
      y_expand: true,
    });

    menuItem.actor.add_child(icofavBtn);
    icofavBtn.connect('clicked', () => {
      this._favoriteToggle(menuItem);
    });

    // Delete button
    const icon = new St.Icon({
      icon_name: 'edit-delete-symbolic',
      style_class: 'system-status-icon',
    });

    const icoBtn = new St.Button({
      style_class: 'ci-action-btn',
      can_focus: true,
      child: icon,
      x_align: Clutter.ActorAlign.END,
      x_expand: false,
      y_expand: true,
    });

    menuItem.actor.add_child(icoBtn);
    icoBtn.connect('clicked', () => {
      this._deleteEntryAndRestoreLatest(menuItem.entry);
    });

    menuItem.connect('destroy', () => {
      delete menuItem.entry.menuItem;
      menuItem.thumbnail = null;
      if (!menuItem.entry.favorite) {
        this.activeHistoryMenuItems--;
      }
    });
    menuItem.connect('key-focus-in', () => {
      if (!menuItem.entry.favorite) {
        ensureActorVisibleInScrollView(this.historyScrollView, menuItem);
      }
    });

    if (entry.favorite) {
      this.favoritesSection.addMenuItem(menuItem, insertIndex);
    } else {
      this.historySection.addMenuItem(menuItem, insertIndex);

      this.activeHistoryMenuItems++;
    }

    if (selectEntry) {
      this._selectEntry(entry, updateClipboard);
    }
  }

  _handleMenuItemKeyEvent(event, menuItem) {
    if (event.get_key_unicode() === 'f') {
      this._favoriteToggle(menuItem);
    }
    if (event.get_key_code() === 119) {
      const next = menuItem.entry.prev || menuItem.entry.next;
      if (next?.menuItem) {
        global.stage.set_key_focus(next.menuItem);
      }
      this._deleteEntryAndRestoreLatest(menuItem.entry);
    }
  }

  _updateButtonText(entry) {
    if (!(TOPBAR_DISPLAY_MODE === 1 || TOPBAR_DISPLAY_MODE === 2)) {
      return;
    }

    if (PRIVATE_MODE) {
      this._buttonText.set_text('…');
    } else if (entry) {
      const text = entry.type === DS.TYPE_TEXT ? entry.text : _('Image');
      this._buttonText.set_text(this._truncated(text, MAX_TOPBAR_LENGTH));
    } else {
      this._buttonText.set_text('');
    }
  }

  _setEntryLabel(menuItem) {
    const entry = menuItem.entry;
    if (entry.type === DS.TYPE_TEXT) {
      if (menuItem.thumbnail) {
        menuItem.thumbnail.content = null;
        menuItem.thumbnail.hide();
      }
      menuItem.label.set_text(this._truncated(entry.text, MAX_VISIBLE_CHARS));
    } else if (entry.type === DS.TYPE_IMAGE) {
      menuItem.label.set_text(this._imageLabel(entry));
      this._showThumbnail(menuItem, entry);
    } else {
      throw new TypeError('Unknown type: ' + entry.type);
    }
  }

  _imageLabel(entry) {
    return `${_('Image')} ${entry.width}×${entry.height} · ${GLib.format_size(entry.size)}`;
  }

  _showThumbnail(menuItem, entry) {
    let thumbnail = menuItem.thumbnail;
    if (!thumbnail) {
      thumbnail = new St.Widget({
        style_class: 'ci-image-thumbnail',
        y_align: Clutter.ActorAlign.CENTER,
        content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
      });
      menuItem.insert_child_below(thumbnail, menuItem.label);
      menuItem.thumbnail = thumbnail;
    }
    thumbnail.show();
    thumbnail.content = null;

    this._loadThumbnail(entry, (content) => {
      // The menu item may have been destroyed or reused for another entry while we were decoding.
      if (menuItem.thumbnail === thumbnail && menuItem.entry === entry) {
        thumbnail.content = content;
      }
    });
  }

  /** Calls `callback` with Clutter content for the entry's thumbnail, or null if it can't be built. */
  _loadThumbnail(entry, callback) {
    const cached = this._thumbnails.get(entry.hash);
    if (cached) {
      // Re-insert so the least recently used thumbnail is the first key.
      this._thumbnails.delete(entry.hash);
      this._thumbnails.set(entry.hash, cached);
      callback(cached);
      return;
    }

    this._withImageBytes(entry, (bytes) => {
      if (this._cancellable.is_cancelled()) {
        return;
      }
      if (!bytes) {
        callback(null);
        return;
      }

      // Decoded on a worker thread so big screenshots don't stall the shell.
      GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
        Gio.MemoryInputStream.new_from_bytes(bytes),
        THUMBNAIL_WIDTH,
        THUMBNAIL_HEIGHT,
        true,
        this._cancellable,
        (_source, res) => {
          let content = null;
          try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
            const width = pixbuf.get_width();
            const height = pixbuf.get_height();
            content = St.ImageContent.new_with_preferred_size(width, height);
            content.set_bytes(
              pixbuf.read_pixel_bytes(),
              pixbuf.get_has_alpha()
                ? Cogl.PixelFormat.RGBA_8888
                : Cogl.PixelFormat.RGB_888,
              width,
              height,
              pixbuf.get_rowstride(),
            );
          } catch (e) {
            content = null;
            if (this._cancellable.is_cancelled()) {
              return;
            }
            console.error(e);
          }

          if (content) {
            this._thumbnails.set(entry.hash, content);
            if (this._thumbnails.size > THUMBNAIL_CACHE_SIZE) {
              this._thumbnails.delete(this._thumbnails.keys().next().value);
            }
          }
          callback(content);
        },
      );
    });
  }

  _favoriteToggle(menuItem) {
    const entry = menuItem.entry;
    const wasSelected = this.currentlySelectedEntry?.id === entry.id;

    // Move to front (end of list)
    (entry.favorite ? this.entries : this.favoriteEntries).append(entry);
    this._removeEntry(entry);
    entry.favorite = !entry.favorite;
    this._addEntry(entry, wasSelected, false, 0);
    this._maybeRestoreMenuPages();
    global.stage.set_key_focus(entry.menuItem);

    if (CACHE_ONLY_FAVORITES && !entry.favorite) {
      if (entry.diskId) {
        Store.deleteEntry(entry.diskId, true);
        delete entry.diskId;
        if (entry.type === DS.TYPE_IMAGE) {
          this._moveImageToMemory(entry);
        }
      }
      return;
    }

    if (entry.diskId) {
      Store.updateFavoriteStatus(entry.diskId, entry.favorite);
    } else {
      entry.diskId = this.nextDiskId++;

      this._persistEntry(entry);
      Store.updateFavoriteStatus(entry.diskId, true);
    }
  }

  _removeAll() {
    if (CONFIRM_ON_CLEAR) {
      this._confirmRemoveAll();
    } else {
      this._clearHistory();
    }
  }

  _confirmRemoveAll() {
    const title = _('Clear all?');
    const message = _('Are you sure you want to delete all clipboard items?');
    const sub_message = _('This operation cannot be undone.');

    openConfirmDialog(
      title,
      message,
      sub_message,
      _('Clear'),
      _('Cancel'),
      () => {
        this._clearHistory();
      },
    );
  }

  _clearHistory() {
    if (this.currentlySelectedEntry && !this.currentlySelectedEntry.favorite) {
      this._resetSelectedMenuItem(true);
    }

    // Favorites aren't touched when clearing history
    this.entries = new DS.LinkedList();
    this.historySection.removeAll();

    Store.resetDatabase(this._currentStateBuilder.bind(this));
  }

  _removeEntry(entry, fullyDelete, humanGenerated) {
    if (fullyDelete) {
      entry.detach();

      if (entry.diskId) {
        Store.deleteEntry(entry.diskId, entry.favorite);
      }
      if (entry.type === DS.TYPE_IMAGE) {
        Store.deleteImageBlob(entry.hash);
        this._thumbnails.delete(entry.hash);
      }
    }

    if (entry.id === this.currentlySelectedEntry?.id) {
      this._resetSelectedMenuItem(humanGenerated);
    }
    entry.menuItem?.destroy();
    if (fullyDelete) {
      this._maybeRestoreMenuPages();
    }
  }

  _pruneOldestEntries() {
    let entry = this.entries.head;
    while (entry) {
      const overCount = this.entries.length > MAX_REGISTRY_LENGTH;
      const overText = this.entries.bytes > MAX_BYTES;
      const overImages = this.entries.imageBytes > MAX_IMAGE_CACHE_BYTES;
      if (!overCount && !overText && !overImages) {
        break;
      }

      const next = entry.next;
      // Text and images have separate byte budgets, so only evict the type that is over its own.
      if (
        overCount ||
        (overText && entry.type === DS.TYPE_TEXT) ||
        (overImages && entry.type === DS.TYPE_IMAGE)
      ) {
        this._removeEntry(entry, true);
      }
      entry = next;
    }

    Store.maybePerformLogCompaction(this._currentStateBuilder.bind(this));
  }

  _selectEntry(entry, updateClipboard, triggerPaste) {
    this.currentlySelectedEntry?.menuItem?.setOrnament(PopupMenu.Ornament.NONE);
    this.currentlySelectedEntry = entry;

    entry.menuItem?.setOrnament(PopupMenu.Ornament.DOT);
    this._updateButtonText(entry);
    if (updateClipboard !== false) {
      const paste = PASTE_ON_SELECTION && triggerPaste;
      if (entry.type === DS.TYPE_TEXT) {
        this._setClipboardText(entry.text);
        if (paste) {
          this._triggerPasteHack();
        }
      } else if (entry.type === DS.TYPE_IMAGE) {
        this._restoreImageToClipboard(entry, paste);
      } else {
        throw new TypeError('Unknown type: ' + entry.type);
      }
    }
  }

  _setClipboardText(text) {
    if (this._debouncing !== undefined) {
      this._debouncing++;
    }

    Clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    Clipboard.set_text(St.ClipboardType.PRIMARY, text);
  }

  /** Calls `callback` with the image's PNG bytes: from memory if held, else from disk (null if unreadable). */
  _withImageBytes(entry, callback) {
    if (entry.bytes) {
      callback(entry.bytes);
    } else {
      Store.loadImageBytes(entry.hash, callback);
    }
  }

  _restoreImageToClipboard(entry, triggerPaste) {
    this._withImageBytes(entry, (bytes) => {
      // The user may have picked another entry while the blob was loading.
      if (
        this._cancellable.is_cancelled() ||
        this.currentlySelectedEntry !== entry
      ) {
        return;
      }
      if (!bytes) {
        console.log(
          this.extension.uuid,
          'Image data is unavailable:',
          entry.hash,
        );
        return;
      }

      this._setClipboardImage(bytes);
      if (triggerPaste) {
        this._triggerPasteHack();
      }
    });
  }

  _setClipboardImage(bytes) {
    if (this._debouncing !== undefined) {
      this._debouncing++;
    }

    Clipboard.set_content(St.ClipboardType.CLIPBOARD, IMAGE_MIMETYPE, bytes);
  }

  /**
   * Appends the entry to the log. Image blobs are written first and then released from memory,
   * unless the entry is memory-only (non-favorite while only favorites are cached).
   */
  _persistEntry(entry) {
    if (entry.type === DS.TYPE_TEXT) {
      Store.storeTextEntry(entry.text);
    } else if (entry.type === DS.TYPE_IMAGE) {
      Store.storeImageEntry(entry, entry.bytes, (ok) => {
        if (ok && entry.diskId && (entry.favorite || !CACHE_ONLY_FAVORITES)) {
          delete entry.bytes;
        }
      });
    } else {
      throw new TypeError('Unknown type: ' + entry.type);
    }
  }

  /** The entry just left the disk cache: keep its PNG in memory, then drop the blob. */
  _moveImageToMemory(entry) {
    this._withImageBytes(entry, (bytes) => {
      if (bytes) {
        entry.bytes = bytes;
      }
      // Skip if the user re-favorited the entry meanwhile: its blob is needed again.
      if (entry.diskId === undefined) {
        Store.deleteImageBlob(entry.hash);
      }
    });
  }

  /** Calls `done` once every non-favorite image is in memory, so their blobs can be deleted. */
  _holdImagesInMemory(done) {
    const missing = [];
    for (const entry of this.entries) {
      if (entry.type === DS.TYPE_IMAGE && !entry.bytes) {
        missing.push(entry);
      }
    }

    let remaining = missing.length;
    if (remaining === 0) {
      done();
      return;
    }
    for (const entry of missing) {
      Store.loadImageBytes(entry.hash, (bytes) => {
        if (bytes) {
          entry.bytes = bytes;
        }
        if (--remaining === 0) {
          done();
        }
      });
    }
  }

  _triggerPasteHack() {
    this._pasteHackCallbackId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      1, // Just post to the end of the event loop
      () => {
        const SHIFT_L = 42;
        const INSERT = 110;

        const eventTime = Clutter.get_current_event_time() * 1000;
        VirtualKeyboard().notify_key(
          eventTime,
          SHIFT_L,
          Clutter.KeyState.PRESSED,
        );
        VirtualKeyboard().notify_key(
          eventTime,
          INSERT,
          Clutter.KeyState.PRESSED,
        );
        VirtualKeyboard().notify_key(
          eventTime,
          INSERT,
          Clutter.KeyState.RELEASED,
        );
        VirtualKeyboard().notify_key(
          eventTime,
          SHIFT_L,
          Clutter.KeyState.RELEASED,
        );

        this._pasteHackCallbackId = undefined;
        return false;
      },
    );
  }

  _onMenuItemSelectedAndMenuClose(menuItem) {
    this._moveEntryFirst(menuItem.entry);
    this._selectEntry(menuItem.entry, true, true);
    this.menu.close();
  }

  _resetSelectedMenuItem(resetClipboard) {
    this.currentlySelectedEntry = undefined;
    this._updateButtonText();
    if (resetClipboard) {
      this._setClipboardText('');
    }
  }

  _restoreFavoritedEntries() {
    for (let entry = this.favoriteEntries.last(); entry; entry = entry.prev) {
      this._addEntry(entry);
    }
  }

  _maybeRestoreMenuPages() {
    if (this.activeHistoryMenuItems > 0) {
      return;
    }

    for (
      let entry = this.entries.last();
      entry && this.activeHistoryMenuItems < PAGE_SIZE;
      entry = entry.prev
    ) {
      this._addEntry(entry, this.currentlySelectedEntry === entry);
    }
  }

  /**
   * Our pagination implementation is purposefully "broken." The idea is simply to do no unnecessary
   * work. As a consequence, if a user navigates to some page and then starts copying/moving items,
   * those items will appear on the currently visible page even though they don't belong there. This
   * could kind of be considered a feature since it means you can go back to some cluster of copied
   * items and start copying stuff from the same cluster and have it all show up together.
   *
   * Note that over time (as the user copies items), the page reclamation process will morph the
   * current page into the first page. This is the only way to make the user-visible state match our
   * backing store after changing pages.
   *
   * Also note that the use of `last` and `next` is correct. Menu items are ordered from latest to
   * oldest whereas `entries` is ordered from oldest to latest.
   */
  _navigatePrevPage() {
    if (this.searchEntryFront) {
      this.populateSearchResults(this.searchEntry.get_text(), false);
      return;
    }

    const items = this.historySection._getMenuItems();
    if (items.length === 0) {
      return;
    }

    const start = items[0].entry;
    for (
      let entry = start.nextCyclic(), i = items.length - 1;
      entry !== start && i >= 0;
      entry = entry.nextCyclic()
    ) {
      this._rewriteMenuItem(items[i--], entry);
    }
  }

  _navigateNextPage() {
    if (this.searchEntryFront) {
      this.populateSearchResults(this.searchEntry.get_text(), true);
      return;
    }

    const items = this.historySection._getMenuItems();
    if (items.length === 0) {
      return;
    }

    const start = items[items.length - 1].entry;
    for (
      let entry = start.prevCyclic(), i = 0;
      entry !== start && i < items.length;
      entry = entry.prevCyclic()
    ) {
      this._rewriteMenuItem(items[i++], entry);
    }
  }

  _rewriteMenuItem(item, entry) {
    // The previous entry must stop pointing at this item. Otherwise removing it later (e.g. pruning
    // the oldest entry) destroys the item that now displays `entry`.
    if (item.entry.menuItem === item) {
      delete item.entry.menuItem;
    }

    if (item.entry.id === this.currentlySelectedEntry?.id) {
      item.setOrnament(PopupMenu.Ornament.NONE);
    }

    item.entry = entry;
    entry.menuItem = item;

    this._setEntryLabel(item);
    if (entry.id === this.currentlySelectedEntry?.id) {
      item.setOrnament(PopupMenu.Ornament.DOT);
    }
  }

  _onSearchTextChanged() {
    const query = this.searchEntry.get_text();

    if (!query) {
      this.historySection.removeAll();
      this.favoritesSection.removeAll();

      this.searchEntryFront = this.searchEntryBack = undefined;
      this._restoreFavoritedEntries();
      this._maybeRestoreMenuPages();
      return;
    }

    this.searchEntryFront = this.searchEntryBack = this.entries.last();
    this.populateSearchResults(query);
  }

  populateSearchResults(query, forward) {
    if (!this.searchEntryFront) {
      return;
    }

    this.historySection.removeAll();
    this.favoritesSection.removeAll();

    if (typeof forward !== 'boolean') {
      forward = true;
    }

    query = query.toLowerCase();
    let searchExp;
    try {
      searchExp = new RegExp(query, 'i');
    } catch {}
    const start = forward ? this.searchEntryFront : this.searchEntryBack;
    let entry = start;

    while (this.activeHistoryMenuItems < PAGE_SIZE) {
      if (entry.type === DS.TYPE_TEXT) {
        let match = entry.text.toLowerCase().indexOf(query);
        if (searchExp && match < 0) {
          match = entry.text.search(searchExp);
        }
        if (match >= 0) {
          this._addEntry(
            entry,
            entry === this.currentlySelectedEntry,
            false,
            forward ? undefined : 0,
          );
          entry.menuItem.label.set_text(
            this._truncated(
              entry.text,
              match - 40,
              match + MAX_VISIBLE_CHARS - 40,
            ),
          );
        }
      } else if (entry.type === DS.TYPE_IMAGE) {
        // Images are searchable by their label, e.g. "Image 1920×1080".
        const label = this._imageLabel(entry);
        if (
          label.toLowerCase().includes(query) ||
          (searchExp && label.search(searchExp) >= 0)
        ) {
          this._addEntry(
            entry,
            entry === this.currentlySelectedEntry,
            false,
            forward ? undefined : 0,
          );
        }
      } else {
        throw new TypeError('Unknown type: ' + entry.type);
      }

      entry = forward ? entry.prevCyclic() : entry.nextCyclic();
      if (entry === start) {
        break;
      }
    }

    if (forward) {
      this.searchEntryBack = this.searchEntryFront.nextCyclic();
      this.searchEntryFront = entry;
    } else {
      this.searchEntryFront = this.searchEntryBack.prevCyclic();
      this.searchEntryBack = entry;
    }
  }

  _shouldAbortClipboardQuery(kind) {
    if (PRIVATE_MODE) {
      return true;
    }

    if (
      IGNORE_PASSWORD_MIMES &&
      Clipboard.get_mimetypes(kind).includes(
        // Note that we should check for the value "secret" but there don't appear to be any other
        // values so it's not worth the trouble right now.
        'x-kde-passwordManagerHint',
      )
    ) {
      console.log(this.uuid, 'Ignoring password entry.');
      return true;
    }

    return false;
  }

  _queryClipboard() {
    if (this._shouldAbortClipboardQuery(St.Clipboard.CLIPBOARD)) {
      return;
    }

    // Text wins when both are offered: spreadsheets and rich-text editors put a rendered PNG next
    // to the text, and the text is what the user wants there.
    const mimetypes = Clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
    if (
      !mimetypes.some((mimetype) => TEXT_MIMETYPES.includes(mimetype)) &&
      mimetypes.includes(IMAGE_MIMETYPE)
    ) {
      this._queryClipboardImage();
      return;
    }

    Clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
      this._processClipboardContent(text, true);
    });
  }

  _queryClipboardImage() {
    // Ignore the change we caused ourselves by restoring an entry.
    if (this._debouncing > 0) {
      this._debouncing--;
      return;
    }

    Clipboard.get_content(
      St.ClipboardType.CLIPBOARD,
      IMAGE_MIMETYPE,
      (_, bytes) => {
        if (!this._cancellable.is_cancelled()) {
          this._processClipboardImage(bytes);
        }
      },
    );
  }

  _queryPrimaryClipboard() {
    if (this._shouldAbortClipboardQuery(St.Clipboard.PRIMARY)) {
      return;
    }

    Clipboard.get_text(St.ClipboardType.PRIMARY, (_, text) => {
      const last = this.entries.last();
      text = this._processClipboardContent(text, false);
      if (
        last &&
        last.type === DS.TYPE_TEXT &&
        text &&
        text.length !== last.text.length &&
        (text.endsWith(last.text) ||
          text.startsWith(last.text) ||
          last.text.endsWith(text) ||
          last.text.startsWith(text))
      ) {
        this._removeEntry(last, true);
      }
    });
  }

  _processClipboardContent(text, selectEntry) {
    if (this._debouncing > 0) {
      this._debouncing--;
      return;
    }

    if (STRIP_TEXT && text) {
      text = text.trim();
    }
    if (!text) {
      return;
    }

    let entry =
      this.entries.findTextItem(text) ||
      this.favoriteEntries.findTextItem(text);
    if (entry) {
      this._reuseEntry(entry, selectEntry);
    } else {
      entry = new DS.LLNode();
      entry.id = this.nextId++;
      entry.diskId = CACHE_ONLY_FAVORITES ? undefined : this.nextDiskId++;
      entry.type = DS.TYPE_TEXT;
      entry.text = text;
      entry.favorite = false;
      this.entries.append(entry);
      this._addEntry(entry, selectEntry, false, 0);

      if (!CACHE_ONLY_FAVORITES) {
        Store.storeTextEntry(text);
      }
      this._pruneOldestEntries();
    }

    this._notifyCopied();

    return text;
  }

  _processClipboardImage(bytes) {
    if (!bytes || bytes.get_size() === 0) {
      return;
    }
    if (bytes.get_size() > MAX_IMAGE_BYTES) {
      console.log(this.extension.uuid, 'Ignoring image over the size limit.');
      return;
    }

    const dimensions = readPngDimensions(bytes);
    if (!dimensions) {
      console.log(this.extension.uuid, 'Ignoring image that is not a PNG.');
      return;
    }

    const hash = GLib.compute_checksum_for_bytes(
      GLib.ChecksumType.SHA256,
      bytes,
    );
    let entry =
      this.entries.findImageItem(hash) ||
      this.favoriteEntries.findImageItem(hash);
    if (entry) {
      this._reuseEntry(entry, true);
    } else {
      entry = new DS.LLNode();
      entry.id = this.nextId++;
      entry.diskId = CACHE_ONLY_FAVORITES ? undefined : this.nextDiskId++;
      entry.type = DS.TYPE_IMAGE;
      entry.hash = hash;
      entry.size = bytes.get_size();
      entry.width = dimensions.width;
      entry.height = dimensions.height;
      entry.bytes = bytes;
      entry.favorite = false;
      this.entries.append(entry);
      this._addEntry(entry, true, false, 0);

      if (!CACHE_ONLY_FAVORITES) {
        this._persistEntry(entry);
      }
      this._pruneOldestEntries();
    }

    this._notifyCopied();
  }

  /** An already-known entry was copied again: bring it to the front and mark it selected. */
  _reuseEntry(entry, selectEntry) {
    const isFirst =
      entry === this.entries.last() || entry === this.favoriteEntries.last();
    if (!isFirst) {
      this._moveEntryFirst(entry);
    }
    if (selectEntry && (!isFirst || entry !== this.currentlySelectedEntry)) {
      this._selectEntry(entry, false);
    }
  }

  _notifyCopied() {
    if (!NOTIFY_ON_COPY) {
      return;
    }

    this._showNotification(_('Copied to clipboard'), null, (notif) => {
      notif.addAction(_('Cancel'), () =>
        this._deleteEntryAndRestoreLatest(this.currentlySelectedEntry),
      );
    });
  }

  _moveEntryFirst(entry) {
    if (!MOVE_ITEM_FIRST) {
      return;
    }

    let menu;
    let entries;
    if (entry.favorite) {
      menu = this.favoritesSection;
      entries = this.favoriteEntries;
    } else {
      menu = this.historySection;
      entries = this.entries;
    }

    if (entry.menuItem) {
      menu.moveMenuItem(entry.menuItem, 0);
    } else {
      this._addEntry(entry, false, false, 0);
    }

    entries.append(entry);
    if (entry.diskId) {
      Store.moveEntryToEnd(entry.diskId);
    }
  }

  _currentStateBuilder() {
    const state = [];

    this.nextDiskId = 1;
    for (const entry of this.favoriteEntries) {
      entry.diskId = this.nextDiskId++;
      state.push(entry);
    }
    for (const entry of this.entries) {
      if (CACHE_ONLY_FAVORITES) {
        delete entry.diskId;
      } else {
        entry.diskId = this.nextDiskId++;
        state.push(entry);
      }
    }

    return state;
  }

  _setupSelectionChangeListener() {
    this._debouncing = 0;

    this.selection = Shell.Global.get().get_display().get_selection();
    this._selectionOwnerChangedId = this.selection.connect(
      'owner-changed',
      (_, selectionType) => {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
          this._queryClipboard();
        } else if (
          PROCESS_PRIMARY_SELECTION &&
          selectionType === Meta.SelectionType.SELECTION_PRIMARY
        ) {
          this._queryPrimaryClipboard();
        }
      },
    );
  }

  _disconnectSelectionListener() {
    if (!this._selectionOwnerChangedId) {
      return;
    }

    this.selection.disconnect(this._selectionOwnerChangedId);
    this.selection = undefined;
    this._selectionOwnerChangedId = undefined;
  }

  _deleteEntryAndRestoreLatest(entry) {
    this._removeEntry(entry, true, true);

    if (!this.currentlySelectedEntry) {
      const nextEntry = this.entries.last();
      if (nextEntry) {
        this._selectEntry(nextEntry, true);
      }
    }
  }

  _initNotifSource() {
    if (this._notifSource) {
      return;
    }

    this._notifSource = new MessageTray.Source({
      title: this.extension.indicatorName,
      iconName: INDICATOR_ICON,
    });
    this._notifSource.connect('destroy', () => {
      this._notifSource = undefined;
    });
    Main.messageTray.add(this._notifSource);
  }

  _showNotification(title, message, transformFn) {
    const dndOn = () =>
      !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
        'show-banners',
      );
    if (PRIVATE_MODE || dndOn()) {
      return;
    }

    this._initNotifSource();

    let notification;
    if (this._notifSource.count === 0) {
      notification = new MessageTray.Notification({
        source: this._notifSource,
        title,
        body: message,
        isTransient: true,
      });
    } else {
      notification = this._notifSource.notifications[0];
      notification.set({
        title,
        body: message,
      });
      notification.clearActions();
    }

    if (typeof transformFn === 'function') {
      transformFn(notification);
    }

    this._notifSource.addNotification(notification);
  }

  _updatePrivateModeState() {
    // We hide the history in private mode because it will be out of sync
    // (selected item will not reflect clipboard)
    this.scrollViewMenuSection.actor.visible = !PRIVATE_MODE;
    this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATE_MODE;

    if (PRIVATE_MODE) {
      this.icon.add_style_class_name('private-mode');
      this._updateButtonText();
    } else {
      this.icon.remove_style_class_name('private-mode');
      if (this.currentlySelectedEntry) {
        this._selectEntry(this.currentlySelectedEntry, true);
      } else {
        this._resetSelectedMenuItem(true);
      }
    }
  }

  _fetchSettings() {
    MAX_REGISTRY_LENGTH = this.settings.get_int(SettingsFields.HISTORY_SIZE);
    MAX_BYTES =
      (1 << 20) * this.settings.get_int(SettingsFields.CACHE_FILE_SIZE);
    WINDOW_WIDTH_PERCENTAGE = this.settings.get_int(
      SettingsFields.WINDOW_WIDTH_PERCENTAGE,
    );
    CACHE_ONLY_FAVORITES = this.settings.get_boolean(
      SettingsFields.CACHE_ONLY_FAVORITES,
    );
    MOVE_ITEM_FIRST = this.settings.get_boolean(SettingsFields.MOVE_ITEM_FIRST);
    NOTIFY_ON_COPY = this.settings.get_boolean(SettingsFields.NOTIFY_ON_COPY);
    CONFIRM_ON_CLEAR = this.settings.get_boolean(
      SettingsFields.CONFIRM_ON_CLEAR,
    );
    ENABLE_KEYBINDING = this.settings.get_boolean(
      SettingsFields.ENABLE_KEYBINDING,
    );
    MAX_TOPBAR_LENGTH = this.settings.get_int(
      SettingsFields.TOPBAR_PREVIEW_SIZE,
    );
    TOPBAR_DISPLAY_MODE = this.settings.get_int(
      SettingsFields.TOPBAR_DISPLAY_MODE_ID,
    );
    DISABLE_DOWN_ARROW = this.settings.get_boolean(
      SettingsFields.DISABLE_DOWN_ARROW,
    );
    STRIP_TEXT = this.settings.get_boolean(SettingsFields.STRIP_TEXT);
    PRIVATE_MODE = this.settings.get_boolean(SettingsFields.PRIVATE_MODE);
    PASTE_ON_SELECTION = this.settings.get_boolean(
      SettingsFields.PASTE_ON_SELECTION,
    );
    PROCESS_PRIMARY_SELECTION = this.settings.get_boolean(
      SettingsFields.PROCESS_PRIMARY_SELECTION,
    );
    IGNORE_PASSWORD_MIMES = this.settings.get_boolean(
      SettingsFields.IGNORE_PASSWORD_MIMES,
    );
    ENABLE_TYPEAHEAD_SEARCH = this.settings.get_boolean(
      SettingsFields.ENABLE_TYPEAHEAD_SEARCH,
    );
    MAX_IMAGE_BYTES =
      (1 << 20) * this.settings.get_int(SettingsFields.MAX_IMAGE_SIZE);
    MAX_IMAGE_CACHE_BYTES =
      (1 << 20) * this.settings.get_int(SettingsFields.IMAGE_CACHE_SIZE);
  }

  _onSettingsChange() {
    const prevCacheOnlyFavorites = CACHE_ONLY_FAVORITES;
    const prevPrivateMode = PRIVATE_MODE;

    this._fetchSettings();

    if (
      prevCacheOnlyFavorites !== undefined &&
      CACHE_ONLY_FAVORITES !== prevCacheOnlyFavorites
    ) {
      if (CACHE_ONLY_FAVORITES) {
        // Non-favorite images must be in memory before the reset deletes their blobs.
        this._holdImagesInMemory(() => {
          if (CACHE_ONLY_FAVORITES && !this._cancellable.is_cancelled()) {
            Store.resetDatabase(this._currentStateBuilder.bind(this));
          }
        });
      } else {
        for (const entry of this.entries) {
          entry.diskId = this.nextDiskId++;
          this._persistEntry(entry);
        }
      }
    }

    if (prevPrivateMode !== undefined && PRIVATE_MODE !== prevPrivateMode) {
      this._updatePrivateModeState();
    }

    // Remove old entries in case the registry size changed
    this._pruneOldestEntries();

    // Re-set menu-items labels in case preview size changed
    const resetLabel = (item) => this._setEntryLabel(item);
    this.favoritesSection._getMenuItems().forEach(resetLabel);
    this.historySection._getMenuItems().forEach(resetLabel);

    this._updateTopbarLayout();
    if (this.currentlySelectedEntry) {
      this._updateButtonText(this.currentlySelectedEntry);
    }
    this._setMenuWidth();

    if (ENABLE_KEYBINDING) {
      this._bindShortcuts();
    } else {
      this._unbindShortcuts();
    }
  }

  _bindShortcuts() {
    this._unbindShortcuts();
    this._bindShortcut(SETTING_KEY_CLEAR_HISTORY, () => {
      if (this.entries) {
        this._removeAll();
      }
    });
    this._bindShortcut(SETTING_KEY_PREV_ENTRY, () => {
      if (this.entries) {
        this._previousEntry();
      }
    });
    this._bindShortcut(SETTING_KEY_NEXT_ENTRY, () => {
      if (this.entries) {
        this._nextEntry();
      }
    });
    this._bindShortcut(SETTING_KEY_TOGGLE_MENU, () => this.menu.toggle());
    this._bindShortcut(SETTING_KEY_TOGGLE_MENU_AT_POINTER, () =>
      this._toggleMenuAtPointer(),
    );
    this._bindShortcut(SETTING_KEY_PRIVATE_MODE, () =>
      this.privateModeMenuItem.toggle(),
    );
  }

  _unbindShortcuts() {
    this._shortcutsBindingIds.forEach((id) => Main.wm.removeKeybinding(id));

    this._shortcutsBindingIds = [];
  }

  _toggleMenuAtPointer() {
    if (this.menu.isOpen) {
      this.menu.close();
      return;
    }
    const [x, y] = global.get_pointer();
    this._pointerMenuMaxHeight = this._computePointerMenuMaxHeight(y);
    this._pointerAnchor.set_position(x, y);
    this._pointerAnchor.show();
    this.menu.sourceActor = this._pointerAnchor;
    this.menu.open();
    // open() is a no-op when the menu is empty; don't leave the anchor swapped in.
    if (!this.menu.isOpen) {
      this._restoreMenuSource();
      this._hidePointerAnchor();
    }
  }

  // BoxPointer only flips to the other side when the whole menu fits there, so
  // cap the height to the larger side of the pointer (PanelMenu's default cap is
  // the full work area, which never fits on either side).
  _computePointerMenuMaxHeight(pointerY) {
    const monitor = global.display.get_current_monitor();
    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor);
    const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const below = workArea.y + workArea.height - (pointerY + 1);
    const above = pointerY - workArea.y;
    const available = Math.max(below, above) - POINTER_MENU_MARGIN * scaleFactor;
    return Math.max(0, Math.round(available / scaleFactor));
  }

  // Runs after PanelMenu.Button's own handler, which sets the full-height cap.
  _applyPointerMenuMaxHeight() {
    if (this._pointerMenuMaxHeight !== undefined) {
      this.menu.actor.style = `max-height: ${this._pointerMenuMaxHeight}px;`;
    }
  }

  _restoreMenuSource() {
    this._pointerMenuMaxHeight = undefined;
    if (this.menu.sourceActor !== this) {
      this.menu.sourceActor = this;
    }
  }

  _hidePointerAnchor() {
    if (!this.menu.isOpen) {
      this._pointerAnchor?.hide();
    }
  }

  _bindShortcut(name, cb) {
    const ModeType = Shell.hasOwnProperty('ActionMode')
      ? Shell.ActionMode
      : Shell.KeyBindingMode;

    Main.wm.addKeybinding(
      name,
      this.settings,
      Meta.KeyBindingFlags.NONE,
      ModeType.ALL,
      cb.bind(this),
    );

    this._shortcutsBindingIds.push(name);
  }

  _updateTopbarLayout() {
    if (TOPBAR_DISPLAY_MODE === 3) {
      this.icon.visible = false;
      this._buttonText.visible = false;

      this._style_class = this.style_class;
      this.style_class = '';
    } else if (this._style_class) {
      this.style_class = this._style_class;
    }

    if (TOPBAR_DISPLAY_MODE === 0) {
      this.icon.visible = true;
      this._buttonText.visible = false;
    }
    if (TOPBAR_DISPLAY_MODE === 1) {
      this.icon.visible = false;
      this._buttonText.visible = true;
    }
    if (TOPBAR_DISPLAY_MODE === 2) {
      this.icon.visible = true;
      this._buttonText.visible = true;
    }
    this._downArrow.visible = !DISABLE_DOWN_ARROW;
  }

  _disconnectSettings() {
    if (!this._settingsChangedId) {
      return;
    }

    this.settings.disconnect(this._settingsChangedId);
    this._settingsChangedId = undefined;
  }

  _openSettings() {
    this.extension.openPreferences();
    this.menu.close();
  }

  _previousEntry() {
    this._selectNextPrevEntry(
      this.currentlySelectedEntry.nextCyclic() || this.entries.head,
    );
  }

  _nextEntry() {
    this._selectNextPrevEntry(
      this.currentlySelectedEntry.prevCyclic() || this.entries.last(),
    );
  }

  _selectNextPrevEntry(entry) {
    if (!entry) {
      return;
    }

    this._selectEntry(entry, true);
    this._showNotification(
      _('Copied'),
      entry.type === DS.TYPE_TEXT ? entry.text : this._imageLabel(entry),
    );
  }

  _truncated(s, start, end) {
    if (start < 0) {
      start = 0;
    }
    if (!end) {
      end = start;
      start = 0;
    }
    if (end > s.length) {
      end = s.length;
    }

    const includesStart = start === 0;
    const includesEnd = end === s.length;
    const isMiddle = !includesStart && !includesEnd;
    const length = end - start;
    const overflow = s.length > length;

    // Reduce regex search space. If the string is mostly whitespace,
    // we might end up removing too many characters, but oh well.
    s = s.substring(start, end + 100);

    // Remove new lines and extra spaces so the text fits nicely on one line
    s = s.replace(/\s+/g, ' ').trim();

    if (includesStart && overflow) {
      s = s.substring(0, length - 1) + '…';
    }
    if (includesEnd && overflow) {
      s = '…' + s.substring(1, length);
    }
    if (isMiddle) {
      s = '…' + s.substring(1, length - 1) + '…';
    }

    return s;
  }
}

const ClipboardIndicatorObj = GObject.registerClass(ClipboardIndicator);

export default class ClipboardHistoryExtension extends Extension {
  enable() {
    this.indicatorName = `${this.metadata.name} Indicator`;

    Store.init(this.uuid);

    this.clipboardIndicator = new ClipboardIndicatorObj(this);
    Main.panel.addToStatusArea(this.indicatorName, this.clipboardIndicator, 1);
  }

  disable() {
    this.clipboardIndicator.destroy();
    this.clipboardIndicator = undefined;

    Store.destroy();
  }
}
