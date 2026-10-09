// native-looking pages for plugins: Telegram's own UniversalFragment (the list screen many of its
// settings are built on), filled from a plain description. Rows are the app's own cells: headers,
// buttons with icons, switches, hints, chat rows with avatars, and a profile-like header.
//
// Needs `unsafe.jvm`. It relies on app internals (UniversalFragment, UItem), which a future app
// version may change; everything that touches them is in this file.

export type NativeIcon =
  | 'msg_channel' | 'msg_add' | 'msg_addbot' | 'msg_edit' | 'msg_pin' | 'msg_unpin' | 'msg_folders'
  | 'msg_settings' | 'msg_delete' | 'msg_leave' | 'msg_mute' | 'msg_unmute' | 'msg_archive'
  | 'msg_unarchive' | 'msg_markread' | 'msg_openin' | 'msg2_folder' | 'msg_link' | 'msg_remove'
  | 'msg_message' | 'msg_select'
  // any other drawable of the app, by resource name
  | (string & {})

export type NativeItem =
  /** a large header with an avatar, a title and a subtitle, as atop a profile */
  | { type: 'profile', title: string, subtitle?: string, account: number, chatId: number }
  /** a section header */
  | { type: 'header', text: string }
  /** gray hint text, also separating sections */
  | { type: 'hint', text?: string }
  | {
    type: 'button'
    text: string
    icon?: NativeIcon
    /** shown on the right */
    value?: string
    style?: 'accent' | 'danger'
    onClick?: () => void
    onLongClick?: () => void
  }
  | { type: 'switch', text: string, checked: boolean, onChange: (checked: boolean) => void }
  /** a chat row with its avatar, title and subscribers or members */
  | { type: 'chat', account: number, chatId: number, onClick?: () => void, onLongClick?: () => void }

export interface NativePageOptions {
  title: string
  /** the rows; called on the plugin's queue when the page opens and on every `invalidate()` */
  items: () => NativeItem[]
  onClose?: () => void
}

export interface NativePage {
  /** rebuilds the rows from `items()` */
  invalidate(): void
  close(): void
}

const cls = (name: string): any => inu.jvm.cls(name)

interface PageState {
  options: NativePageOptions
  /**
   * `items()` as of the last invalidate. It is taken on the plugin's queue, where every plugin API
   * works, while the app asks for the rows on the UI thread
   */
  snapshot: NativeItem[]
  /** the rows' handlers, by row id */
  handlers: Map<number, NativeItem>
  fragment: JavaObject | null
  /** the profile header, reused across rebuilds */
  header: { view: JavaObject, avatar: JavaObject, title: JavaObject, subtitle: JavaObject } | null
}

const pages = new Map<number, PageState>()
let nextPageId = 1

function later(task: () => void): void {
  // fragment callbacks run on the UI thread, where plugin-thread APIs are unavailable
  Promise.resolve().then(task).catch((e) => {
    console.error('native-ui: handler failed', e)
  })
}

/**
 * Runs a routine on the UI thread. Presenting, updating and closing a page call back into the
 * page's JS methods right away, which a JS callback (inu.jvm.runnable) may not do: the plugin's
 * engine can't be re-entered. A routine never enters the engine itself
 */
function onUiThread(routine: JavaObject): void {
  cls('org.telegram.messenger.AndroidUtilities').callStatic('runOnUIThread', routine)
}

let iconIds: Map<string, number> | null = null
function iconId(name: NativeIcon | undefined): number {
  if (!name) return 0
  iconIds ??= new Map()
  let id = iconIds.get(name)
  if (id === undefined) {
    const context = cls('org.telegram.messenger.ApplicationLoader').getStaticField('applicationContext')
    id = context.call('getResources').call('getIdentifier', name, 'drawable', context.call('getPackageName')) as number
    iconIds.set(name, id)
  }
  return id
}

function getChat(account: number, chatId: number): JavaObject | null {
  return cls('org.telegram.messenger.MessagesController').callStatic('getInstance', account).call('getChat', chatId)
}

function buildHeader(context: JavaObject): NonNullable<PageState['header']> {
  const LinearLayout = cls('android.widget.LinearLayout')
  const TextView = cls('android.widget.TextView')
  const Theme = cls('org.telegram.ui.ActionBar.Theme')
  const LayoutHelper = cls('org.telegram.ui.Components.LayoutHelper')
  const dp = (value: number): number => cls('org.telegram.messenger.AndroidUtilities').callStatic('dp', value)
  const color = (key: string): number => Theme.callStatic('getColor', Theme.getStaticField(key))

  const view = new LinearLayout(context)
  view.call('setOrientation', 1)
  view.call('setGravity', 1)
  view.call('setPadding', 0, dp(20), 0, dp(20))
  view.call('setBackgroundColor', color('key_windowBackgroundWhite'))

  const avatar = new (cls('org.telegram.ui.Components.BackupImageView'))(context)
  avatar.call('setRoundRadius', dp(45))
  view.call('addView', avatar, LayoutHelper.callStatic('createLinear', 90, 90))

  const title = new TextView(context)
  title.call('setTextSize', 1, 22)
  try {
    title.call('setTypeface', cls('org.telegram.messenger.AndroidUtilities').callStatic('bold'))
  } catch {}
  title.call('setTextColor', color('key_windowBackgroundWhiteBlackText'))
  title.call('setGravity', 1)
  title.call('setPadding', dp(24), dp(12), dp(24), 0)
  view.call('addView', title, LayoutHelper.callStatic('createLinear', -1, -2))

  const subtitle = new TextView(context)
  subtitle.call('setTextSize', 1, 15)
  subtitle.call('setTextColor', color('key_windowBackgroundWhiteGrayText'))
  subtitle.call('setGravity', 1)
  subtitle.call('setPadding', dp(24), dp(4), dp(24), 0)
  view.call('addView', subtitle, LayoutHelper.callStatic('createLinear', -1, -2))

  return { view, avatar, title, subtitle }
}

function fillItems(state: PageState, items: JavaObject, context: JavaObject): void {
  const UItem = cls('org.telegram.ui.Components.UItem')
  state.handlers.clear()
  let id = 1

  for (const item of state.snapshot) {
    const rowId = id++
    let row: JavaObject | null = null
    switch (item.type) {
      case 'profile': {
        state.header ??= buildHeader(context)
        const chat = getChat(item.account, item.chatId)
        if (chat) {
          const drawable = new (cls('org.telegram.ui.Components.AvatarDrawable'))()
          drawable.call('setInfo(ILorg/telegram/tgnet/TLRPC$Chat;)V', item.account, chat)
          state.header.avatar.call('setForUserOrChat', chat, drawable)
        }
        state.header.title.call('setText', item.title)
        state.header.subtitle.call('setText', item.subtitle ?? '')
        row = UItem.callStatic('asCustom', rowId, state.header.view)
        break
      }
      case 'header':
        row = UItem.callStatic('asHeader', rowId, item.text)
        break
      case 'hint':
        row = UItem.callStatic('asShadow', rowId, item.text ?? null)
        break
      case 'button':
        row = item.value === undefined
          ? UItem.callStatic('asButton', rowId, iconId(item.icon), item.text)
          : UItem.callStatic('asButton', rowId, iconId(item.icon), item.text, item.value)
        if (item.style === 'danger') row!.call('red')
        if (item.style === 'accent') row!.call('accent')
        break
      case 'switch':
        row = UItem.callStatic('asCheck', rowId, item.text).call('setChecked', item.checked)
        break
      case 'chat': {
        const chat = getChat(item.account, item.chatId)
        if (!chat) continue
        row = UItem.callStatic('asProfileCell', chat)
        row!.setField('id', rowId)
        break
      }
    }
    if (row) {
      state.handlers.set(rowId, item)
      items.call('add', row)
    }
  }
}

let fragmentClass: DefinedClass | null = null
function pageClass(): DefinedClass {
  fragmentClass ??= inu.jvm.defineClass({
    superclass: cls('org.telegram.ui.Components.UniversalFragment'),
    fields: { pageId: 'int' },
    methods: {
      getTitle: (self) => pages.get(self.getField('pageId'))?.options.title ?? '',
      fillItems: (self, items) => {
        const state = pages.get(self.getField('pageId'))
        if (state) fillItems(state, items, self.call('getContext') ?? self.call('getParentActivity'))
      },
      onClick: (self, item) => {
        const state = pages.get(self.getField('pageId'))
        const row = state?.handlers.get(item.getField('id'))
        if (!state || !row) return
        if (row.type === 'switch') {
          const checked = !row.checked
          later(() => {
            row.onChange(checked)
            invalidate(state)
          })
        } else if ((row.type === 'button' || row.type === 'chat') && row.onClick) {
          later(row.onClick)
        }
      },
      onLongClick: (self, item) => {
        const row = pages.get(self.getField('pageId'))?.handlers.get(item.getField('id'))
        if (!row || (row.type !== 'button' && row.type !== 'chat') || !row.onLongClick) return false
        later(row.onLongClick)
        return true
      },
      onFragmentDestroy: {
        params: [],
        returns: 'void',
        body: (self) => {
          inu.jvm.callSuper(fragmentClass!, self, 'onFragmentDestroy')
          const pageId: number = self.getField('pageId')
          const state = pages.get(pageId)
          pages.delete(pageId)
          if (state?.options.onClose) later(state.options.onClose)
        },
      },
    },
  })
  return fragmentClass
}

function invalidate(state: PageState): void {
  const fragment = state.fragment
  if (!fragment) return
  state.snapshot = state.options.items()
  onUiThread(inu.jvm.routine(function () {
    const list = fragment.listView
    if (list !== null) list.adapter.update(true)
  }))
}

/** Opens a native page on top of the current screen */
export function openNativePage(options: NativePageOptions): NativePage {
  const pageId = nextPageId++
  const state: PageState = { options, snapshot: options.items(), handlers: new Map(), fragment: null, header: null }
  pages.set(pageId, state)

  const fragment = new (pageClass())()
  fragment.setField('pageId', pageId)
  state.fragment = fragment
  const LaunchActivity = cls('org.telegram.ui.LaunchActivity')
  onUiThread(inu.jvm.routine(function () {
    const top = LaunchActivity.getLastFragment()
    if (top !== null) top.presentFragment(fragment)
  }))

  return {
    invalidate: () => invalidate(state),
    close: () => onUiThread(inu.jvm.routine(function () {
      fragment.finishFragment()
    })),
  }
}
