// src/plugin.js
import { 
  Component, 
  Keymap, 
  Menu, 
  Notice, 
  parseFrontMatterAliases, 
  parseFrontMatterTags, 
  TFolder, 
  Plugin 
} from "obsidian";
import { renameTag, findTargets } from "./renaming";
import { Tag } from "./Tag";
import { around } from "monkey-around";
import { ConfirmModal } from "./ConfirmModal"; // Import the custom ConfirmModal
import { TagWranglerSettings, TagWranglerSettingTab } from './settings';

/**
* Utility function to attach event listeners.
* @param {HTMLElement} el - The element to attach the event to.
* @param {string} event - The event type.
* @param {string} selector - The CSS selector to match.
* @param {Function} callback - The callback function.
* @param {Object} options - Additional options for the event listener.
* @returns {Function} - A function to remove the event listener.
*/
function onElement(el, event, selector, callback, options) {
  el.on(event, selector, callback, options);
  return () => el.off(event, selector, callback, options);
}

export default class TagWrangler extends Plugin {
  pageAliases = new Map();
  tagPages = new Map();

  /**
   * Retrieves the tag page associated with a given tag.
   * @param {string} tag - The tag name.
   * @returns {string|undefined} - The file path of the tag page.
   */
  tagPage(tag) {
      return Array.from(this.tagPages.get(Tag.canonical(tag)) || "")[0];
  }

  /**
   * Opens a tag page file in a new or existing leaf.
   * @param {TFile} file - The tag page file.
   * @param {boolean} isNew - Whether the file is newly created.
   * @param {boolean} newLeaf - Whether to open in a new leaf.
   * @returns {Promise<void>}
   */
  openTagPage(file, isNew, newLeaf) {
      const openState = {
          eState: isNew ? { rename: "all" } : { focus: true },  // Rename new page, focus existing
          ...(isNew ? { state: { mode: "source" } } : {})       // and set source mode for new page
      };
      return this.app.workspace.getLeaf(newLeaf).openFile(file, openState);
  }

  /**
   * Creates a new tag page.
   * Automatically creates the base folder if it doesn't exist.
   * @param {string} tagName - The name of the tag.
   * @param {boolean} newLeaf - Whether to open in a new leaf.
   * @returns {Promise<void>}
   */
  async createTagPage(tagName, newLeaf) {
      const tag = new Tag(tagName);
      const tp_evt = { tag: tag.canonical, file: undefined };
      this.app.workspace.trigger("tag-page:will-create", tp_evt);

      let file = tp_evt.file && await tp_evt.file;
      if (!file) {
          const baseName = new Tag(tagName).name.split("/").join(" ");
          const folderPath = this.settings.baseFolder || "tags";
          let folder = this.app.vault.getAbstractFileByPath(folderPath);

          // **Check if the folder exists and is indeed a folder**
          if (!folder || !(folder instanceof TFolder)) { // ***Corrected Line***
              try {
                  // **Attempt to create the base folder**
                  await this.app.vault.createFolder(folderPath);
                  new Notice(`Folder "${folderPath}" was created automatically.`);
                  folder = this.app.vault.getAbstractFileByPath(folderPath);
              } catch (error) {
                  console.error(`Failed to create folder "${folderPath}":`, error);
                  new Notice(`Failed to create folder "${folderPath}". Please create it manually or update the base folder in settings.`);
                  return;
              }
          }

          // **Proceed to create the tag page within the (now existing) base folder**
          const path = this.app.vault.getAvailablePath(folder.path + "/" + baseName, "md");

          try {
              file = await this.app.vault.create(path, [
                  "---",
                  `Aliases: [ ${JSON.stringify(Tag.toTag(tagName))} ]`,
                  "---",
                  ""
              ].join("\n"));
              new Notice(`Tag page for #${tagName} created successfully.`);
          } catch (error) {
              console.error(`Failed to create tag page for #${tagName}:`, error);
              new Notice(`Failed to create tag page for #${tagName}.`);
              return;
          }
      }

      tp_evt.file = file;
      await this.openTagPage(file, true, newLeaf);
      this.app.workspace.trigger("tag-page:did-create", tp_evt);
  }

  /**
   * Lifecycle method called when the plugin is loaded.
   */
  async onload() {
      console.log('Loading Tag Wrangler Plugin');

      // Load settings with defaults
      this.settings = Object.assign(new TagWranglerSettings(), await this.loadData());

      // Add the settings tab
      this.addSettingTab(new TagWranglerSettingTab(this.app, this));

      // Register the event to handle the editor menu for tag wrangling
      this.registerEvent(
          this.app.workspace.on("editor-menu", (menu, editor) => {
              const token = editor.getClickableTokenAt(editor.getCursor());
              if (token?.type === "tag") {
                  this.setupMenu(menu, token.text);
              }
          })
      );

      // Register context menu for tags in the tag pane
      this.register(
          onElement(document, "contextmenu", ".tag-pane-tag", this.onMenu.bind(this), { capture: true })
      );

      // Register a hover link source for tags in the tag pane
      const tagHoverMain = "tag-wrangler:tag-pane";
      this.app.workspace.registerHoverLinkSource(tagHoverMain, { display: 'Tags View', defaultMod: true });

      // Register handlers for tag interactions in different contexts
      this.addChild(
          // Tags in the tags view
          new TagPageUIHandler(this, {
              hoverSource: tagHoverMain,
              selector: ".tag-pane-tag",
              container: ".tag-container",
              toTag: (el) => el.find(".tag-pane-tag-text, .tag-pane-tag .tree-item-inner-text")?.textContent
          })
      );

      this.addChild(
          // Reading mode / tag links in markdown preview
          new TagPageUIHandler(this, {
              hoverSource: "preview",
              selector: 'a.tag[href^="#"]',
              container: ".markdown-preview-view, .markdown-embed, .workspace-leaf-content",
              toTag: (el) => el.getAttribute("href")
          })
      );

      this.addChild(
          // Property view (metadata tags)
          new TagPageUIHandler(this, {
              hoverSource: "preview",
              selector: '.metadata-property[data-property-key="tags"] .multi-select-pill-content',
              container: ".metadata-properties",
              toTag: (el) => el.textContent
          })
      );

      this.addChild(
          // Edit mode (tag interactions in the markdown source view)
          new TagPageUIHandler(this, {
              hoverSource: "editor",
              selector: "span.cm-hashtag",
              container: ".markdown-source-view",
              toTag: (el) => {
                  let tagName = el.textContent;
                  if (!el.matches(".cm-formatting")) {
                      for (let t = el.previousElementSibling; t?.matches("span.cm-hashtag:not(.cm-formatting)"); t = t.previousElementSibling) {
                          tagName = t.textContent + tagName;
                      }
                  }
                  for (let t = el.nextElementSibling; t?.matches("span.cm-hashtag:not(.cm-formatting)"); t = t.nextElementSibling) {
                      tagName += t.textContent;
                  }
                  return tagName;
              }
          })
      );

      // Tag dragging setup
      this.register(
          onElement(document, "pointerdown", ".tag-pane-tag", (_, targetEl) => {
              targetEl.draggable = "true";
          }, { capture: true })
      );

      this.register(
          onElement(document, "dragstart", ".tag-pane-tag", (event, targetEl) => {
              const tagName = targetEl.find(".tag-pane-tag-text, .tag-pane-tag .tree-item-inner-text")?.textContent;
              console.log("Creating ConfirmModal with app:", this.app); // Debugging
              new ConfirmModal(
                  this.app,
                  `Create Tag Page`,
                  `A tag page for ${tagName} does not exist. Create it?`,
                  () => {
                      this.createTagPage(tagName, Keymap.isModEvent(event));
                  },
                  () => {
                      const search = this.app.internalPlugins.getPluginById("global-search")?.instance;
                      search?.openGlobalSearch("tag:#" + tagName);
                  }
              ).open();
          }, { capture: false })
      );

      // Handle drag over and drop events for tags
      const dropHandler = (e, targetEl, info = this.app.dragManager.draggable, drop) => {
          if (info?.source !== "tag-wrangler" || e.defaultPrevented) return;
          const tag = targetEl.find(".tag-pane-tag-text, .tag-pane-tag .tree-item-inner-text")?.textContent;
          const dest = tag + "/" + Tag.toName(info.title).split("/").pop();
          if (Tag.canonical(tag) === Tag.canonical(info.title)) return;
          e.dataTransfer.dropEffect = "move";
          e.preventDefault();
          if (drop) {
              this.rename(Tag.toName(info.title), dest);
          } else {
              this.app.dragManager.updateHover(targetEl, "is-being-dragged-over");
              this.app.dragManager.setAction(`Rename to ${dest}`);
          }
      };

      this.register(onElement(document.body, "dragover", ".tag-pane-tag.tree-item-self", dropHandler, { capture: true }));
      this.register(onElement(document.body, "dragenter", ".tag-pane-tag.tree-item-self", dropHandler, { capture: true }));

      // Register drop event
      this.registerDomEvent(window, "drop", (e) => {
          const targetEl = e.target?.matchParent(".tag-pane-tag.tree-item-self", e.currentTarget);
          if (!targetEl) return;
          const info = this.app.dragManager.draggable;
          if (info && !e.defaultPrevented) dropHandler(e, targetEl, info, true);
      }, { capture: true });

      // Track and update tag pages
      const metaCache = this.app.metadataCache;
      const plugin = this;
  
      this.register(around(metaCache, {
          getTags(old) {
              return function getTags() {
                  const tags = old.call(this);
                  const names = new Set(Object.keys(tags).map(t => t.toLowerCase()));
                  for (const t of plugin.tagPages.keys()) {
                      if (!names.has(t)) {
                          tags[plugin.tagPages.get(t).tag] = 0;
                      }
                  }
                  return tags;
              };
          }
      }));

      // Register cache and vault events for tracking tag pages
      this.app.workspace.onLayoutReady(() => {
          metaCache.getCachedFiles().forEach(filename => {
              const fm = metaCache.getCache(filename)?.frontmatter;
              if (fm && parseFrontMatterAliases(fm)?.filter(Tag.isTag)) {
                  this.updatePage(this.app.vault.getAbstractFileByPath(filename), fm);
              }
          });
          this.registerEvent(metaCache.on("changed", (file, data, cache) => this.updatePage(file, cache?.frontmatter)));
          this.registerEvent(this.app.vault.on("delete", file => this.updatePage(file)));
          this.app.workspace.getLeavesOfType("tag").forEach(leaf => leaf?.view?.requestUpdateTags?.());
      });
  }

  /**
   * Saves the plugin settings.
   */
  async saveSettings() {
      await this.saveData(this.settings);
  }

  /**
   * Updates the tag pages based on frontmatter changes.
   * @param {TFile} file - The file being updated.
   * @param {object} frontmatter - The frontmatter of the file.
   */
  updatePage(file, frontmatter) {
      const tags = parseFrontMatterAliases(frontmatter)?.filter(Tag.isTag) || [];
      if (this.pageAliases.has(file)) {
          const oldTags = new Set(tags || []);
          for (const tag of this.pageAliases.get(file)) {
              if (oldTags.has(tag)) continue;
              const key = Tag.canonical(tag);
              const tp = this.tagPages.get(key);
              if (tp) {
                  tp.delete(file);
                  if (!tp.size) this.tagPages.delete(key);
              }
          }
          if (!tags.length) this.pageAliases.delete(file);
      }
      if (tags.length) {
          this.pageAliases.set(file, tags);
          for (const tag of tags) {
              const key = Tag.canonical(tag);
              if (this.tagPages.has(key)) this.tagPages.get(key).add(file);
              else {
                  const tagSet = new Set([file]);
                  tagSet.tag = Tag.toTag(tag);
                  this.tagPages.set(key, tagSet);
              }
          }
      }
  }

  /**
   * Handles the context menu event for a tag element.
   * @param {MouseEvent} e - The mouse event.
   * @param {HTMLElement} tagEl - The tag element.
   */
  onMenu(e, tagEl) {
      let menu = e.obsidian_contextmenu;
      if (!menu) {
          menu = e.obsidian_contextmenu = new Menu();
          setTimeout(() => menu.showAtPosition({ x: e.pageX, y: e.pageY }), 0);
      }

      const tagName = tagEl.find(".tag-pane-tag-text, .tag-pane-tag .tree-item-inner-text").textContent;
      const isHierarchy = tagEl.parentElement.parentElement.find(".collapse-icon");

      this.setupMenu(menu, tagName, isHierarchy);
      if (isHierarchy) {
          const tagParent = tagName.split("/").slice(0, -1).join("/");
          const tagView = this.leafView(tagEl.matchParent(".workspace-leaf"));
          const tagContainer = tagParent ? tagView.tagDoms["#" + tagParent.toLowerCase()] : tagView.root;
          function toggle(collapse) {
              for (const tag of tagContainer.children ?? tagContainer.vChildren.children) tag.setCollapsed(collapse);
          }
          menu.addItem(item("tag-hierarchy", "vertical-three-dots", "Collapse tags at this level", () => toggle(true)))
              .addItem(item("tag-hierarchy", "expand-vertically", "Expand tags at this level", () => toggle(false)));
      }
  }

  /**
   * Sets up the context menu for a tag.
   * @param {Menu} menu - The context menu instance.
   * @param {string} tagName - The name of the tag.
   * @param {boolean} [isHierarchy=false] - Whether the tag is part of a hierarchy.
   */
  setupMenu(menu, tagName, isHierarchy = false) {
      tagName = Tag.toTag(tagName).slice(1);
      const tagPage = this.tagPage(tagName);
      const searchPlugin = this.app.internalPlugins.getPluginById("global-search");
      const search = searchPlugin && searchPlugin.instance;
      const query = search && search.getGlobalSearchQuery();
      const random = this.app.plugins.plugins["smart-random-note"];

      menu.addItem(item("tag-rename", "pencil", "Rename #" + tagName, () => this.rename(tagName)));

      if (tagPage) {
          menu.addItem(
              item("tag-page", "popup-open", "Open tag page", (e) => this.openTagPage(tagPage, false, Keymap.isModEvent(e)))
          );
      } else {
          menu.addItem(
              item("tag-page", "create-new", "Create tag page", (e) => this.createTagPage(tagName, Keymap.isModEvent(e)))
          );
      }

      if (search) {
          menu.addItem(
              item("tag-search", "magnifying-glass", "New search for #" + tagName, () => search.openGlobalSearch("tag:#" + tagName))
          );
          if (query) {
              menu.addItem(
                  item("tag-search", "sheets-in-box", "Require #" + tagName + " in search", () => search.openGlobalSearch(query + " tag:#" + tagName))
              );
          }
          menu.addItem(
              item("tag-search", "crossed-star", "Exclude #" + tagName + " from search", () => search.openGlobalSearch(query + " -tag:#" + tagName))
          );
      }

      if (random) {
          menu.addItem(
              item("tag-random", "dice", "Open random note", async () => {
                  const targets = await findTargets(this.app, new Tag(tagName));
                  random.openRandomNote(targets.map(f => this.app.vault.getAbstractFileByPath(f.filename)));
              })
          );
      }

      this.app.workspace.trigger("tag-wrangler:contextmenu", menu, tagName, { search, query, isHierarchy, tagPage });
  }

  /**
   * Retrieves the view associated with a container element.
   * @param {HTMLElement} containerEl - The container element.
   * @returns {View|undefined} - The associated view.
   */
  leafView(containerEl) {
      let view;
      this.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.containerEl === containerEl) { view = leaf.view; return true; }
      });
      return view;
  }

  /**
   * Renames a tag from `tagName` to `toName`.
   * @param {string} tagName - The current tag name.
   * @param {string} [toName=tagName] - The new tag name.
   */
  async rename(tagName, toName = tagName) {
      try { 
          await renameTag(this.app, tagName, toName); 
      }
      catch (e) { 
          console.error(e); 
          new Notice("Error: " + e); 
      }
  }
}

/**
* Utility function to create a menu item.
* @param {string} section - The menu section.
* @param {string} icon - The icon name.
* @param {string} title - The menu item title.
* @param {Function} click - The click handler function.
* @returns {Function} - A function that configures the menu item.
*/
function item(section, icon, title, click) {
  return i => { 
      i.setIcon(icon)
       .setTitle(title)
       .onClick(click); 
      if (section) i.setSection(section); 
  };
}


/**
* Handles UI interactions for tag pages.
*/
class TagPageUIHandler extends Component {
  /**
   * @param {TagWrangler} plugin - The main plugin instance.
   * @param {Object} opts - Configuration options.
   */
  constructor(plugin, opts) {
      super();
      this.opts = opts;
      this.plugin = plugin;
  }

  /**
   * Lifecycle method called when the component is loaded.
   */
  onload() {
      const { selector, container, hoverSource, toTag } = this.opts;
      this.register(
          onElement(document, "mouseover", selector, (event, targetEl) => {
              const tagName = toTag(targetEl), tp = tagName && this.plugin.tagPage(tagName);
              if (tp) this.plugin.app.workspace.trigger('hover-link', {
                  event, 
                  source: hoverSource, 
                  targetEl, 
                  linktext: tp.path,
                  hoverParent: targetEl.matchParent(container)
              });
          }, { capture: false })
      );

      if (hoverSource === "preview") {
          this.register(
              onElement(document, "contextmenu", selector, (e, targetEl) => {
                  let menu = e.obsidian_contextmenu;
                  if (!menu) {
                      menu = e.obsidian_contextmenu = new Menu();
                      setTimeout(() => menu.showAtPosition({ x: e.pageX, y: e.pageY }), 0);
                  }
                  this.plugin.setupMenu(menu, toTag(targetEl));
              })
          );
          this.register(
              onElement(document, "dragstart", selector, (event, targetEl) => {
                  const tagName = toTag(targetEl);
                  this.plugin.app.dragManager.onDragStart(event, {
                      source: "tag-wrangler",
                      type: "text",
                      title: tagName,
                      icon: "hashtag",
                  });
              }, { capture: false })
          );
      }

      this.register(
          onElement(document, hoverSource === "editor" ? "mousedown" : "click", selector, (event, targetEl) => {
              const { altKey } = event;
              if (!Keymap.isModEvent(event) && !altKey) return;
              const tagName = toTag(targetEl), tp = tagName && this.plugin.tagPage(tagName);
              if (tp) {
                  this.plugin.openTagPage(tp, false, Keymap.isModEvent(event));
              } else {
                  new ConfirmModal(
                      this.plugin.app,
                      "Create Tag Page",
                      `A tag page for ${tagName} does not exist. Create it?`,
                      () => {
                          this.plugin.createTagPage(tagName, Keymap.isModEvent(event));
                      },
                      () => {
                          const search = this.plugin.app.internalPlugins.getPluginById("global-search")?.instance;
                          search?.openGlobalSearch("tag:#" + tagName);
                      }
                  ).open();
              }
              event.preventDefault();
              event.stopImmediatePropagation();
              return false;
          }, { capture: true })
      );
  }
}
