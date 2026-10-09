// adds a "show as feed" button to the app's folder editor (FilterCreateActivity), right under the
// folder name. There is no public API for this screen, so it relies on the app's internals

import { addFeedFolder, getFeedFolder, listFolders, reloadAppFolders, removeFeedFolder } from './folders.js'
import type { FeedFolder } from './folders.js'

const BUTTON_TEXT = 'Показывать как ленту'
const BUTTON_HINT = 'Каналы папки соберутся в один чат в списке чатов, а сама папка пропадёт из вкладок.'
const RESTORE_TEXT = 'Вернуть папку во вкладки'
const RESTORE_HINT = 'Папка сейчас показывается как один чат в списке чатов.'

function later(task: () => void): void {
  // UI-thread callbacks can't use plugin-thread APIs such as toasts
  Promise.resolve().then(task).catch((e) => {
    console.error('feed: folder editor task failed', e)
  })
}

export function addFeedButtonToFolderEditor(onFeedChanged: () => void): void {
  const FilterCreateActivity = inu.jvm.cls('org.telegram.ui.FilterCreateActivity')
  const ItemInner = inu.jvm.cls('org.telegram.ui.FilterCreateActivity$ItemInner')
  const UserConfig = inu.jvm.cls('org.telegram.messenger.UserConfig')
  const editViewType: number = FilterCreateActivity.getStaticField('VIEW_TYPE_EDIT')

  const context = inu.jvm.cls('org.telegram.messenger.ApplicationLoader').getStaticField('applicationContext')
  const icon: number = context.call('getResources')
    .call('getIdentifier', 'msg_channel', 'drawable', context.call('getPackageName'))

  function accountOf(fragment: JavaObject): { slot: number, userId: number } {
    const slot: number = fragment.call('getCurrentAccount')
    return { slot, userId: UserConfig.callStatic('getInstance', slot).call('getClientUserId') }
  }

  /**
   * The feed this editor's folder is. A folder just created may still carry the number the app
   * gave it, which can be a hidden feed's (see folders.ts) until the app refetches its folders, so
   * the title has to match too
   */
  function feedOf(fragment: JavaObject): FeedFolder | null {
    const filter = fragment.getField('filter')
    const feed = getFeedFolder(accountOf(fragment).userId, filter.getField('id'))
    return feed && feed.title === filter.getField('name') ? feed : null
  }

  async function makeFeed(slot: number, userId: number, folderId: number, title: string): Promise<void> {
    // the folder must be on the server under this number, with this title
    const folder = (await listFolders(inu.account(slot))).find(f => f.id === folderId)
    if (!folder || folder.title.text !== title) {
      reloadAppFolders(slot)
      inu.ui.toast('Папка ещё сохраняется, попробуйте через пару секунд')
      return
    }
    addFeedFolder(userId, { id: folderId, title })
    reloadAppFolders(slot)
    onFeedChanged()
    inu.ui.toast(`«${title}» теперь один чат в списке чатов`)
  }

  function toggleFeed(fragment: JavaObject): void {
    const filter = fragment.getField('filter')
    const folderId: number = filter.getField('id')
    const title: string = filter.getField('name')
    const { slot, userId } = accountOf(fragment)
    const feed = feedOf(fragment)

    if (!feed && fragment.call('hasChanges')) {
      later(() => inu.ui.toast('Сначала сохраните изменения папки'))
      return
    }
    fragment.call('finishFragment')
    if (feed) {
      removeFeedFolder(userId, folderId)
      reloadAppFolders(slot)
      later(() => {
        onFeedChanged()
        inu.ui.toast(`«${feed.title}» снова во вкладках`)
      })
      return
    }
    later(() => {
      makeFeed(slot, userId, folderId, title).catch((e) => {
        console.error('feed: making a feed failed', e)
        inu.ui.toast('Не удалось сделать ленту')
      })
    })
  }

  const ClickListener = inu.jvm.defineClass({
    interfaces: [inu.jvm.cls('android.view.View$OnClickListener')],
    fields: { fragment: 'org.telegram.ui.FilterCreateActivity' },
    methods: {
      onClick: (self) => {
        toggleFeed(self.getField('fragment'))
      },
    },
  })

  inu.xposed.hookMethod(FilterCreateActivity.getDeclaredMethod('updateRows(Z)V'), {
    after: (ctx) => {
      const fragment = ctx.thisObject
      // a folder being created has no id yet, so it can't become a feed
      if (!fragment || fragment.getField('creatingNew') || !fragment.getField('filter')) return
      const isFeed = feedOf(fragment) !== null

      const listener = new ClickListener()
      listener.setField('fragment', fragment)

      const items = fragment.getField('items')
      const count: number = items.call('size')
      let at = count
      for (let i = 0; i < count; i++) {
        if (items.call('get', i).getField('viewType') === editViewType) {
          // after the name field and the shadow below it
          at = Math.min(i + 2, count)
          break
        }
      }
      const button = ItemInner.callStatic('asButton', icon, isFeed ? RESTORE_TEXT : BUTTON_TEXT, isFeed)
      items.call('add', at, button.call('whenClicked', listener))
      items.call('add', at + 1, ItemInner.callStatic('asShadow', isFeed ? RESTORE_HINT : BUTTON_HINT))

      // updateRows already handed the list without our rows to the adapter
      fragment.getField('adapter')?.call('notifyDataSetChanged')
    },
  })
}
