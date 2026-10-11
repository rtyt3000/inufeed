// a feed's "profile": its channels, avatar, icon and name, on a settings page. It edits the folder
// behind the feed through the plugin's own requests, which the plugin's interceptors don't see

import { FOLDER_ICONS, getFeedAvatar, pickAvatar, removeFeedAvatar, useFolderIcon } from './feed-avatar.js'
import { getFeedFolder, listFolders, updateFeedFolder } from './folders.js'
import type { ListedFolder } from './folders.js'

export interface FeedProfileActions {
  /** the feed's channels, title or avatar changed; resolves once the chat list has them */
  changed(): Promise<void>
  chooseTabs(): void
  restore(): void
}

async function loadFolder(account: inu.Account, folderId: number): Promise<ListedFolder | null> {
  return (await listFolders(account)).find(f => f.id === folderId) ?? null
}

async function saveFolder(account: inu.Account, folder: ListedFolder): Promise<void> {
  await account.invokeRpc({ _: 'messages.updateDialogFilter', id: folder.id, filter: folder as tl.RawDialogFilter })
}

const isChannel = (account: inu.Account, peer: tl.TypeInputPeer): boolean => {
  if (peer._ !== 'inputPeerChannel') return false
  const chat = account.getChat(inu.utils.peers.getMarkedPeerId(peer))
  return !chat || chat.broadcast === true
}

function channelsText(count: number): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return `${count} канал`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} канала`
  return `${count} каналов`
}

export function openFeedProfile(account: inu.Account, folderId: number, actions: FeedProfileActions): void {
  let folder: ListedFolder | null = null
  let busy = false

  /** marked ids of the feed's channels, pinned first */
  const channels = (): number[] => {
    if (!folder) return []
    const ids = [...folder.pinned_peers, ...folder.include_peers]
      .filter(peer => isChannel(account, peer))
      .map(peer => inu.utils.peers.getMarkedPeerId(peer))
    return [...new Set(ids)]
  }

  async function update(edit: (folder: ListedFolder) => Promise<void> | void, done: string): Promise<void> {
    if (busy) return
    busy = true
    try {
      const fresh = await loadFolder(account, folderId)
      if (!fresh) {
        inu.ui.toast('Папка не найдена')
        return
      }
      await edit(fresh)
      await saveFolder(account, fresh)
      folder = fresh
      await actions.changed()
      page.invalidate()
      inu.ui.toast(done)
    } catch (e) {
      console.error('feed: saving the folder failed', e)
      inu.ui.toast(e instanceof inu.RpcError ? `Не удалось сохранить: ${e.text}` : 'Не удалось сохранить')
    } finally {
      busy = false
    }
  }

  async function removeChannel(id: number): Promise<void> {
    const title = account.getChat(id)
    const answer = await inu.ui.dialog({
      title: title && 'title' in title ? title.title : 'Канал',
      message: 'Убрать канал из ленты? Он снова появится в списке чатов.',
      positive: 'Убрать',
      negative: 'Отмена',
    })
    if (answer !== 'positive') return
    const without = (peers: tl.TypeInputPeer[]): tl.TypeInputPeer[] =>
      peers.filter(peer => peer._ !== 'inputPeerChannel' || inu.utils.peers.getMarkedPeerId(peer) !== id)
    await update((f) => {
      f.include_peers = without(f.include_peers)
      f.pinned_peers = without(f.pinned_peers)
    }, 'Канал убран из ленты')
  }

  async function chooseChannels(): Promise<void> {
    const current = channels()
    const picked = await inu.ui.selectPeers({
      title: 'Каналы ленты',
      account: account.id,
      peerType: ['broadcast'],
      selected: current,
      allowEmpty: false,
    })
    if (picked === null) return
    const added = picked.filter(id => !current.includes(id))
    const removed = new Set(current.filter(id => !picked.includes(id)))
    if (added.length === 0 && removed.size === 0) return

    await update(async (f) => {
      const keep = (peers: tl.TypeInputPeer[]): tl.TypeInputPeer[] =>
        peers.filter(peer => peer._ !== 'inputPeerChannel' || !removed.has(inu.utils.peers.getMarkedPeerId(peer)))
      f.include_peers = keep(f.include_peers)
      f.pinned_peers = keep(f.pinned_peers)
      const resolved = await account.resolvePeerMany(added)
      for (const peer of resolved) {
        if (peer) f.include_peers.push(peer)
      }
    }, 'Каналы ленты сохранены')
  }

  async function setIcon(emoji: string | undefined): Promise<void> {
    await update((f) => {
      if (emoji) f.emoticon = emoji
      else delete f.emoticon
    }, emoji ? 'Иконка папки сохранена' : 'Иконка папки убрана')
    // an avatar drawn from the icon follows it
    if (getFeedFolder(account.userId, folderId)?.iconAvatar && emoji) {
      if (await useFolderIcon(account, folderId)) avatarChanged()
    }
  }

  async function rename(): Promise<void> {
    const title = (await inu.ui.prompt({ title: 'Название ленты', value: folder?.title.text ?? '', selectAll: true }))?.trim()
    if (!title || title === folder?.title.text) return
    await update((f) => {
      f.title = { _: 'textWithEntities', text: title, entities: [] }
      updateFeedFolder(account.userId, folderId, { title })
    }, 'Лента переименована')
  }

  const report = (what: string) => (e: unknown): void => {
    console.error(`feed: ${what} failed`, e)
  }

  const avatarChanged = (): void => {
    actions.changed().then(() => page.invalidate()).catch(report('updating the avatar'))
  }

  const iconNames = ['Без иконки', ...FOLDER_ICONS.map(([, , name]) => name)]
  const iconIndex = (): number => {
    const current = folder?.emoticon?.replace(/️/g, '')
    return FOLDER_ICONS.findIndex(([emoji]) => emoji === current) + 1
  }

  const page = inu.ui.settingsPage({
    title: 'Лента',
    transient: true,
    items: () => {
      const feed = getFeedFolder(account.userId, folderId)
      const ids = channels()
      const hasAvatar = getFeedAvatar(account.userId, folderId) !== null
      return [
        inu.ui.header(`Каналы · ${folder ? channelsText(ids.length) : 'загрузка…'}`),
        ...ids.map((id) => {
          const chat = account.getChat(id)
          return inu.ui.button({
            id: `channel-${id}`,
            text: (chat && 'title' in chat ? chat.title : undefined) ?? 'Канал',
            icon: inu.icons.avatar(id, { account: account.id }),
            onClick: () => inu.ui.openPage({ type: 'chat', dialogId: id, account: account.id }),
            onSecondaryClick: () => {
              removeChannel(id).catch(report('removing a channel'))
            },
          })
        }),
        inu.ui.button({
          id: 'add-channels',
          text: 'Добавить каналы',
          icon: inu.icons.common('channel'),
          onClick: () => {
            chooseChannels().catch(report('choosing channels'))
          },
        }),
        inu.ui.separator('Удерживайте канал, чтобы убрать его из ленты.'),
        inu.ui.header('Лента'),
        inu.ui.button({
          id: 'avatar',
          text: hasAvatar ? 'Сменить аватарку' : 'Выбрать аватарку',
          onClick: () => {
            pickAvatar(account, folderId).then((changed) => {
              if (changed) avatarChanged()
            }).catch(report('picking the avatar'))
          },
        }),
        ...(hasAvatar
          ? [inu.ui.button({
              id: 'avatar-remove',
              text: 'Убрать аватарку',
              danger: true,
              onClick: () => {
                removeFeedAvatar(account.userId, folderId)
                avatarChanged()
              },
            })]
          : []),
        inu.ui.select({
          id: 'icon',
          text: 'Иконка папки',
          items: iconNames,
          selected: iconIndex(),
          onChange: (index) => {
            setIcon(index === 0 ? undefined : FOLDER_ICONS[index - 1][0]).catch(report('setting the icon'))
          },
        }),
        inu.ui.button({
          id: 'icon-avatar',
          text: 'Иконка папки как аватарка',
          onClick: () => {
            useFolderIcon(account, folderId).then((used) => {
              if (used) avatarChanged()
              else inu.ui.toast('У папки нет иконки')
            }).catch(report('using the folder icon'))
          },
        }),
        inu.ui.button({
          id: 'rename',
          text: 'Название',
          value: feed?.title ?? '',
          icon: inu.icons.common('edit'),
          onClick: () => {
            rename().catch(report('renaming'))
          },
        }),
        inu.ui.button({
          id: 'tabs',
          text: 'Показывать в папках',
          value: String(feed?.showIn?.length ?? 0),
          onClick: () => actions.chooseTabs(),
        }),
        inu.ui.separator(),
        inu.ui.button({
          id: 'restore',
          text: 'Вернуть папку во вкладки',
          danger: true,
          onClick: () => {
            page.dispose()
            actions.restore()
          },
        }),
      ]
    },
  })
  inu.ui.openPage(page)

  loadFolder(account, folderId).then((loaded) => {
    folder = loaded
    page.invalidate()
  }).catch((e) => {
    report('loading the folder')(e)
    inu.ui.toast('Не удалось загрузить папку')
  })
}
