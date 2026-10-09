// a feed's own avatar: a picture the user picks, kept only on this device. The stand-in group of the
// feed gets a made-up photo whose file the plugin puts where the app's cache keeps avatars, so the
// app draws it everywhere without asking the server (see chat-list.ts)

import { getFeedFolder, listFolders, updateFeedFolder } from './folders.js'

/** avatars are square; the app draws them at most this large */
const SIZE = 320

const cls = (name: string): any => inu.jvm.cls(name)

function storageKey(userId: number, folderId: number): string {
  return `feedAvatar:${userId}:${folderId}`
}

export interface FeedAvatar {
  /** changes with every new picture, so the app doesn't draw an old one it has in memory */
  photoId: number
  jpeg: Uint8Array
}

export function getFeedAvatar(userId: number, folderId: number): FeedAvatar | null {
  const photoId = getFeedFolder(userId, folderId)?.photoId
  const stored = localStorage.getItem(storageKey(userId, folderId))
  if (!photoId || stored === null) return null
  try {
    return { photoId, jpeg: inu.utils.fromBase64(stored) }
  } catch {
    return null
  }
}

export function removeFeedAvatar(userId: number, folderId: number): void {
  localStorage.removeItem(storageKey(userId, folderId))
  updateFeedFolder(userId, folderId, { photoId: undefined, iconAvatar: undefined })
}

function saveJpeg(userId: number, folderId: number, jpeg: Uint8Array, fromIcon: boolean): void {
  localStorage.setItem(storageKey(userId, folderId), inu.utils.toBase64(jpeg))
  updateFeedFolder(userId, folderId, { photoId: Date.now(), iconAvatar: fromIcon || undefined })
}

async function saveCanvas(userId: number, folderId: number, canvas: OffscreenCanvas, fromIcon: boolean): Promise<void> {
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer())
  saveJpeg(userId, folderId, jpeg, fromIcon)
}

/** Makes a picture the feed's avatar, from its middle square */
async function saveAvatar(userId: number, folderId: number, source: Blob | Uint8Array): Promise<void> {
  const bitmap = await inu.canvas.decode(source)
  const canvas = inu.canvas.create(SIZE, SIZE)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(
      bitmap,
      (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
      0, 0, SIZE, SIZE,
    )
    await saveCanvas(userId, folderId, canvas, false)
  } finally {
    bitmap.dispose()
    canvas.dispose()
  }
}

/**
 * Folder icons: the emoji a folder's icon is stored as, the app's picture for it (the one Inugram's
 * FolderHelper.getTabIcon draws on folder tabs), and a name
 */
export const FOLDER_ICONS: [emoji: string, drawable: string, name: string][] = [
  ['💬', 'filter_all', 'Все чаты'], ['✅', 'filter_unread', 'Непрочитанные'],
  ['🔔', 'filter_unmuted', 'Со звуком'], ['👤', 'filter_private', 'Личные'],
  ['👥', 'filter_group', 'Группы'], ['📢', 'filter_channels', 'Каналы'], ['🤖', 'filter_bots', 'Боты'],
  ['⭐', 'filter_favorite', 'Избранное'], ['❤', 'filter_love', 'Любовь'], ['🏠', 'filter_home', 'Дом'],
  ['💼', 'filter_work', 'Работа'], ['🎓', 'filter_study', 'Учёба'], ['💰', 'filter_money', 'Деньги'],
  ['📈', 'filter_trade', 'Торговля'], ['🎮', 'filter_game', 'Игры'], ['🎵', 'filter_note', 'Музыка'],
  ['🎨', 'filter_palette', 'Искусство'], ['🎭', 'filter_mask', 'Театр'], ['🍸', 'filter_party', 'Вечеринка'],
  ['✈', 'filter_travel', 'Путешествия'], ['🛫', 'filter_airplane', 'Самолёт'], ['⚽', 'filter_sport', 'Спорт'],
  ['📕', 'filter_book', 'Книги'], ['💡', 'filter_light', 'Идеи'], ['👌', 'filter_like', 'Нравится'],
  ['🐱', 'filter_cat', 'Кот'], ['👑', 'filter_crown', 'Корона'], ['🌹', 'filter_flower', 'Цветы'],
  ['📁', 'filter_custom', 'Папка'], ['📋', 'filter_setup', 'Список'],
]

/** The app's picture for a folder icon emoji, as FolderHelper.getTabIcon picks it */
export function folderIconDrawable(emoji: string | undefined): string {
  const stripped = emoji?.replace(/️/g, '')
  return FOLDER_ICONS.find(([icon]) => icon === stripped)?.[1] ?? 'filter_custom'
}

/** Telegram's peer colors, which folder colors index into */
const FOLDER_COLORS = [0xFFE56555, 0xFFF28C48, 0xFF8E85EE, 0xFF76C84D, 0xFF5FBED5, 0xFF549CDD, 0xFFF2749A]

/** Makes the folder's icon, white on the folder's color, the feed's avatar. Resolves to whether it had one */
export async function useFolderIcon(account: inu.Account, folderId: number): Promise<boolean> {
  const folder = (await listFolders(account)).find(f => f.id === folderId)
  if (!folder?.emoticon) return false

  const context = cls('org.telegram.messenger.ApplicationLoader').getStaticField('applicationContext')
  const resources = context.call('getResources')
  const resId: number = resources.call('getIdentifier', folderIconDrawable(folder.emoticon), 'drawable', context.call('getPackageName'))
  if (resId === 0) return false

  const Bitmap = cls('android.graphics.Bitmap')
  const bitmap = Bitmap.callStatic('createBitmap', SIZE, SIZE, cls('android.graphics.Bitmap$Config').getStaticField('ARGB_8888'))
  try {
    const canvas = new (cls('android.graphics.Canvas'))(bitmap)
    // an ARGB int: the bridge wants it signed
    canvas.call('drawColor', FOLDER_COLORS[(folder.color ?? 5) % FOLDER_COLORS.length] | 0)
    const icon = resources.call('getDrawable', resId).call('mutate')
    icon.call('setColorFilter', new (cls('android.graphics.PorterDuffColorFilter'))(
      0xFFFFFFFF | 0,
      cls('android.graphics.PorterDuff$Mode').getStaticField('SRC_IN'),
    ))
    // the pictures have margins of their own
    const inset = Math.round(SIZE * 0.12)
    icon.call('setBounds', inset, inset, SIZE - inset, SIZE - inset)
    icon.call('draw', canvas)

    const out = new (cls('java.io.ByteArrayOutputStream'))()
    bitmap.call('compress', cls('android.graphics.Bitmap$CompressFormat').getStaticField('JPEG'), 90, out)
    const jpeg: Uint8Array = out.call('toByteArray')
    saveJpeg(account.userId, folderId, jpeg, true)
    return true
  } finally {
    bitmap.call('recycle')
  }
}

/** the pick in progress; the delegate class is shared, so it finds its pick here */
let pending: { userId: number, slot: number, folderId: number, changed: () => void, updater: JavaObject } | null = null
let delegateClass: DefinedClass | null = null

function later(task: () => Promise<void> | void): void {
  // app callbacks run on the UI thread, where plugin-thread APIs are unavailable
  Promise.resolve().then(task).catch((e) => {
    console.error('feed: avatar task failed', e)
    inu.ui.toast('Не удалось сохранить аватарку')
  })
}

/**
 * Opens the app's own photo picker, as for a group's photo: gallery, camera and cropping, plus
 * "delete" when the feed has an avatar. Nothing is uploaded; the cropped picture becomes the
 * feed's avatar. `changed` runs once the avatar changed
 */
export function openAvatarPicker(account: inu.Account, folderId: number, changed: () => void): void {
  const ImageUpdater = cls('org.telegram.ui.Components.ImageUpdater')
  delegateClass ??= inu.jvm.defineClass({
    interfaces: [cls('org.telegram.ui.Components.ImageUpdater$ImageUpdaterDelegate')],
    methods: {
      // called with the cropped picture, already saved in the app's cache
      didUploadPhoto: (_self, _photo, _video, _start, _path, bigSize) => {
        const pick = pending
        if (!pick || !bigSize) return
        const file = cls('org.telegram.messenger.FileLoader').callStatic('getInstance', pick.slot)
          .call('getPathToAttach', bigSize, true)
        const jpeg: Uint8Array = cls('java.nio.file.Files').callStatic('readAllBytes', file.call('toPath'))
        later(async () => {
          await saveAvatar(pick.userId, pick.folderId, jpeg)
          pick.changed()
        })
      },
    },
  })

  const updater = new ImageUpdater(false, ImageUpdater.getStaticField('FOR_TYPE_GROUP'), false)
  // no upload: the picture stays on this device
  updater.call('setUploadAfterSelect', false)
  updater.call('setDelegate', new delegateClass())
  pending = { userId: account.userId, slot: account.id, folderId, changed, updater }

  const hasAvatar = getFeedAvatar(account.userId, folderId) !== null
  const onDelete = inu.jvm.runnable(() => {
    later(() => {
      removeFeedAvatar(account.userId, folderId)
      changed()
    })
  })
  const TYPE_DEFAULT: number = ImageUpdater.getStaticField('TYPE_DEFAULT')
  const LaunchActivity = cls('org.telegram.ui.LaunchActivity')
  // a routine, as opening the menu may call back into the plugin right away
  const open = inu.jvm.routine(function () {
    const top = LaunchActivity.getLastFragment()
    if (top === null) return
    updater.parentFragment = top
    updater.openMenu(hasAvatar, onDelete, null, TYPE_DEFAULT)
  })
  cls('org.telegram.messenger.AndroidUtilities').callStatic('runOnUIThread', open)
}
