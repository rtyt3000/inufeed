// tapping a reply quote in a plugin chat history screen makes the app look for the replied post
// around it as in a real chat, which never loads there and hangs. For feed channels, the reply is
// opened in the channel itself instead

export function openRepliesInChannel(isFeedChannel: (slot: number, dialogId: number) => boolean): void {
  const ChatActivity = inu.jvm.cls('org.telegram.ui.ChatActivity')
  const Delegate = inu.jvm.cls('org.telegram.ui.ChatActivity$ChatMessageCellDelegate')
  const Bundle = inu.jvm.cls('android.os.Bundle')
  const PLUGIN_MODE: number = ChatActivity.getStaticField('inu_MODE_PLUGIN_HISTORY')

  inu.xposed.hookMethod(Delegate.getDeclaredMethod('didPressReplyMessage'), {
    filter: inu.jvm.routine(function () {
      return this.this$0.chatMode === PLUGIN_MODE
    }),
    before: (ctx) => {
      const [cell, replyId, , , longPress] = ctx.args as [JavaObject, number, number, number, boolean]
      const activity: JavaObject = ctx.thisObject!.getField('this$0')
      if (longPress || activity.getField('chatMode') !== PLUGIN_MODE) return

      const message: JavaObject | null = cell.call('getMessageObject')
      if (!message || message.call('isReplyToStory')) return
      const replyTo: JavaObject | null = message.getField('messageOwner').getField('reply_to')
      // a reply to another chat opens that chat already
      if (!replyTo || replyTo.getField('reply_to_peer_id') !== null) return

      const dialogId: number = message.call('getDialogId')
      const slot: number = activity.call('getCurrentAccount')
      if (dialogId >= 0 || !isFeedChannel(slot, dialogId)) return

      const args = new Bundle()
      args.call('putLong', 'chat_id', -dialogId)
      args.call('putInt', 'message_id', replyId)
      activity.call('presentFragment', new ChatActivity(args))
      ctx.setReturnValue(null)
    },
  })
}
