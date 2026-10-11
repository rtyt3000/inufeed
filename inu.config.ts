import { defineConfig } from '@inugram/cli'

export default defineConfig({
  plugins: {
    frinufeed: {
      entry: 'src/feed/index.ts',
      manifest: {
        id: 'rtyt300.frinufeed',
        name: 'Frinugram feed',
        author: '@rtyt3000',
        version: '1.0.1',
        description: 'Turns a chat folder into a single feed of its channels and hides it from the folder tabs',
        icon: 'tg://emoji?id=5936256964760707620',
        grants: [
          'account.read(peers, dialogs, history)',
          'invokeRpc(messages.getDialogFilters, messages.updateDialogFilter)',
          'interceptRpc(messages.getDialogFilters, messages.updateDialogFilter, messages.getHistory, updates.getChannelDifference, channels.readHistory, channels.getFullChannel, channels.getChannels, messages.getPeerDialogs, messages.toggleDialogPin, messages.reorderPinnedDialogs, account.updateNotifySettings, folders.editPeerFolders, channels.leaveChannel)',
          'interceptUpdate(updateDialogFilter)',
          'onUpdate(new_message, edit_message, delete_message)',
          // feed rows in the chat list, reply taps and refreshing the app's folders have no public API
          'unsafe.jvm',
          'unsafe.xposed',
        ],
      },
    },
  },
})
