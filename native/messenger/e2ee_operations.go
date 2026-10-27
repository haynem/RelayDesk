package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"strconv"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waMediaTransport"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	waTypes "go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func wrapContent(content *waConsumerApplication.ConsumerApplication_Content) *waConsumerApplication.ConsumerApplication {
	return &waConsumerApplication.ConsumerApplication{Payload: &waConsumerApplication.ConsumerApplication_Payload{Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{Content: content}}}
}
func textContent(text string) *waConsumerApplication.ConsumerApplication {
	return wrapContent(&waConsumerApplication.ConsumerApplication_Content{Content: &waConsumerApplication.ConsumerApplication_Content_MessageText{MessageText: &waCommon.MessageText{Text: proto.String(text)}}})
}
func (w *encryptedWorker) messageKey(record *storedFB) *waCommon.MessageKey {
	key := &waCommon.MessageKey{RemoteJID: proto.String(record.Chat), FromMe: proto.Bool(record.Mine), ID: proto.String(record.ID)}
	if jid, err := waTypes.ParseJID(record.Chat); err == nil && jid.Server == waTypes.GroupServer {
		key.Participant = proto.String(record.Sender)
	}
	return key
}
func (w *encryptedWorker) handle(command workerCommand) {
	defer func() {
		if recover() != nil {
			w.response(command.ID, map[string]any{"ok": false, "error": "internal_error", "attempted": true})
		}
	}()
	ctx, cancel := context.WithTimeout(w.ctx, 180*time.Second)
	defer cancel()
	reject := func(code string) {
		w.response(command.ID, map[string]any{"ok": false, "error": code, "attempted": false})
	}
	unknown := func() {
		w.response(command.ID, map[string]any{"ok": false, "error": "operation_result_unknown", "attempted": true})
	}
	if command.Mode == "status" {
		w.response(command.ID, map[string]any{"ok": true, "historyReady": w.hasHistory(), "connected": w.wa.IsConnected()})
		return
	}
	if command.Mode == "snapshot" {
		messages, err := w.snapshot(ctx)
		if err != nil {
			reject("snapshot_failed")
			return
		}
		w.response(command.ID, map[string]any{"ok": true, "messages": messages})
		return
	}
	if command.Mode == "recover-history" {
		if !command.Approved {
			reject("approval_required")
			return
		}
		w.recoverHistory(ctx, command)
		return
	}
	jid, err := waTypes.ParseJID(command.JID)
	if err != nil || jid.User != command.ThreadID || (jid.Server != waTypes.MessengerServer && jid.Server != waTypes.GroupServer) {
		reject("invalid_thread")
		return
	}
	if command.Mode == "history" {
		w.history(ctx, command, jid)
		return
	}
	if command.Mode == "members" {
		if jid.Server == waTypes.GroupServer {
			info, e := w.wa.GetGroupInfo(ctx, jid)
			if e != nil {
				reject("members_failed")
				return
			}
			members := []map[string]string{}
			for _, p := range info.Participants {
				name := w.names[p.JID.User]
				if name == "" {
					name = p.JID.User
				}
				members = append(members, map[string]string{"id": p.JID.User, "name": name})
			}
			w.response(command.ID, map[string]any{"ok": true, "members": members, "title": info.Name})
			return
		}
		self := strconv.FormatInt(w.viewer, 10)
		name := w.names[jid.User]
		if name == "" {
			name = jid.User
		}
		w.response(command.ID, map[string]any{"ok": true, "members": []map[string]string{{"id": self, "name": "自分"}, {"id": jid.User, "name": name}}})
		return
	}
	if command.Mode == "download" {
		record, e := w.record(command.ThreadID, command.MessageID)
		if e != nil || record.Wire.Deleted {
			reject("attachment_unavailable")
			return
		}
		data, e := w.download(ctx, record)
		if e != nil {
			reject("attachment_unavailable")
			return
		}
		w.response(command.ID, map[string]any{"ok": true, "data": data})
		return
	}
	if !w.wa.IsConnected() {
		reject("e2ee_disconnected")
		return
	}
	if !command.Approved || command.OperationID == "" {
		reject("approval_required")
		return
	}
	if command.Mode == "send" {
		w.send(ctx, command, jid)
		return
	}
	record, err := w.record(command.ThreadID, command.MessageID)
	if err != nil || record.Wire.Deleted {
		reject("message_unavailable")
		return
	}
	if command.Mode == "receipt" {
		sender, e := waTypes.ParseJID(record.Sender)
		if e != nil {
			reject("invalid_sender")
			return
		}
		if w.wa.MarkRead(ctx, []waTypes.MessageID{record.ID}, time.UnixMilli(record.Timestamp), jid, sender) != nil {
			unknown()
			return
		}
		w.response(command.ID, map[string]any{"ok": true})
		return
	}
	if record.Wire.Text != command.ExpectedText {
		reject("message_changed")
		return
	}
	if (command.Mode == "edit" || command.Mode == "delete") && !record.Mine {
		reject("not_own_message")
		return
	}
	var consumer *waConsumerApplication.ConsumerApplication
	control := storedControl{Thread: command.ThreadID, Target: record.ID, Actor: strconv.FormatInt(w.viewer, 10), Timestamp: time.Now().UnixMilli()}
	switch command.Mode {
	case "edit":
		if strings.TrimSpace(command.Text) == "" || len(command.Text) > 40000 {
			reject("invalid_content")
			return
		}
		consumer = wrapContent(&waConsumerApplication.ConsumerApplication_Content{Content: &waConsumerApplication.ConsumerApplication_Content_EditMessage{EditMessage: &waConsumerApplication.ConsumerApplication_EditMessage{Key: w.messageKey(record), Message: &waCommon.MessageText{Text: proto.String(command.Text)}, TimestampMS: proto.Int64(control.Timestamp)}}})
		control.Kind = "edit"
		control.Text = command.Text
	case "delete":
		consumer = &waConsumerApplication.ConsumerApplication{Payload: &waConsumerApplication.ConsumerApplication_Payload{Payload: &waConsumerApplication.ConsumerApplication_Payload_ApplicationData{ApplicationData: &waConsumerApplication.ConsumerApplication_ApplicationData{ApplicationContent: &waConsumerApplication.ConsumerApplication_ApplicationData_Revoke{Revoke: &waConsumerApplication.ConsumerApplication_RevokeMessage{Key: w.messageKey(record)}}}}}}
		control.Kind = "delete"
	case "react-add", "react-remove":
		emoji := command.Emoji
		if command.Mode == "react-remove" {
			emoji = ""
		}
		if len(emoji) > 400 {
			reject("invalid_emoji")
			return
		}
		consumer = wrapContent(&waConsumerApplication.ConsumerApplication_Content{Content: &waConsumerApplication.ConsumerApplication_Content_ReactionMessage{ReactionMessage: &waConsumerApplication.ConsumerApplication_ReactionMessage{Key: w.messageKey(record), Text: proto.String(emoji), SenderTimestampMS: proto.Int64(control.Timestamp)}}})
		control.Kind = "reaction"
		control.Text = emoji
	default:
		reject("unsupported_operation")
		return
	}
	if _, err = w.wa.SendFBMessage(ctx, jid, consumer, nil, whatsmeow.SendRequestExtra{ID: strings.ReplaceAll(command.OperationID, "-", "")}); err != nil {
		unknown()
		return
	}
	if !w.control(control, true) {
		unknown()
		return
	}
	w.response(command.ID, map[string]any{"ok": true})
}
func (w *encryptedWorker) send(ctx context.Context, command workerCommand, jid waTypes.JID) {
	reject := func(code string) {
		w.response(command.ID, map[string]any{"ok": false, "error": code, "attempted": false})
	}
	unknown := func() {
		w.response(command.ID, map[string]any{"ok": false, "error": "send_result_unknown", "attempted": true})
	}
	if len(command.Text) > 40000 || len(command.Files) > 10 || strings.TrimSpace(command.Text) == "" && len(command.Files) == 0 {
		reject("invalid_content")
		return
	}
	var size int
	for _, f := range command.Files {
		size += len(f.Data)
		if f.Name == "" || len(f.Data) > 25*1024*1024 || size > 100*1024*1024 {
			reject("invalid_file")
			return
		}
	}
	metadata := &waMsgApplication.MessageApplication_Metadata{}
	if command.ReplyTo != "" {
		quoted, e := w.record(command.ThreadID, command.ReplyTo)
		if e != nil || quoted.Wire.Deleted {
			reject("quote_unavailable")
			return
		}
		metadata.QuotedMessage = &waMsgApplication.MessageApplication_Metadata_QuotedMessage{StanzaID: proto.String(quoted.ID), Participant: proto.String(quoted.Sender)}
	}
	last := ""
	send := func(consumer *waConsumerApplication.ConsumerApplication, id string) bool {
		response, err := w.wa.SendFBMessage(ctx, jid, consumer, metadata, whatsmeow.SendRequestExtra{ID: id})
		if err != nil || response.ID == "" {
			return false
		}
		last = response.ID
		return w.sendEventCopy(ctx, jid, response.ID, command.ReplyTo, consumer)
	}
	if command.Text != "" {
		if !send(textContent(command.Text), strings.ReplaceAll(command.OperationID, "-", "")) {
			unknown()
			return
		}
	}
	for index, file := range command.Files {
		consumer, err := w.mediaMessage(ctx, file)
		if err != nil {
			unknown()
			return
		}
		id := strings.ReplaceAll(command.OperationID, "-", "") + strconv.Itoa(index)
		if !send(consumer, id) {
			unknown()
			return
		}
	}
	if last == "" {
		unknown()
		return
	}
	w.response(command.ID, map[string]any{"ok": true, "remoteId": last})
}
func (w *encryptedWorker) mediaMessage(ctx context.Context, file sendFile) (*waConsumerApplication.ConsumerApplication, error) {
	kind := whatsmeow.MediaDocument
	switch {
	case strings.HasPrefix(file.Mime, "image/"):
		kind = whatsmeow.MediaImage
	case strings.HasPrefix(file.Mime, "video/"):
		kind = whatsmeow.MediaVideo
	case strings.HasPrefix(file.Mime, "audio/"):
		kind = whatsmeow.MediaAudio
	}
	if file.Mime == "image/gif" {
		kind = whatsmeow.MediaVideo
	}
	uploaded, err := w.wa.Upload(ctx, file.Data, kind)
	if err != nil {
		return nil, err
	}
	width, height := uint32(400), uint32(400)
	if config, _, e := image.DecodeConfig(bytes.NewReader(file.Data)); e == nil {
		width = uint32(config.Width)
		height = uint32(config.Height)
	}
	transport := &waMediaTransport.WAMediaTransport{Integral: &waMediaTransport.WAMediaTransport_Integral{FileSHA256: uploaded.FileSHA256, MediaKey: uploaded.MediaKey, FileEncSHA256: uploaded.FileEncSHA256, DirectPath: &uploaded.DirectPath, MediaKeyTimestamp: proto.Int64(time.Now().Unix())}, Ancillary: &waMediaTransport.WAMediaTransport_Ancillary{FileLength: proto.Uint64(uint64(len(file.Data))), Mimetype: &file.Mime, Thumbnail: &waMediaTransport.WAMediaTransport_Ancillary_Thumbnail{ThumbnailWidth: &width, ThumbnailHeight: &height}, ObjectID: &uploaded.ObjectID}}
	content := &waConsumerApplication.ConsumerApplication_Content{}
	switch kind {
	case whatsmeow.MediaImage:
		m := &waConsumerApplication.ConsumerApplication_ImageMessage{}
		err = m.Set(&waMediaTransport.ImageTransport{Integral: &waMediaTransport.ImageTransport_Integral{Transport: transport}, Ancillary: &waMediaTransport.ImageTransport_Ancillary{Width: &width, Height: &height}})
		content.Content = &waConsumerApplication.ConsumerApplication_Content_ImageMessage{ImageMessage: m}
	case whatsmeow.MediaVideo:
		m := &waConsumerApplication.ConsumerApplication_VideoMessage{}
		err = m.Set(&waMediaTransport.VideoTransport{Integral: &waMediaTransport.VideoTransport_Integral{Transport: transport}, Ancillary: &waMediaTransport.VideoTransport_Ancillary{Width: &width, Height: &height, GifPlayback: proto.Bool(file.Mime == "image/gif")}})
		content.Content = &waConsumerApplication.ConsumerApplication_Content_VideoMessage{VideoMessage: m}
	case whatsmeow.MediaAudio:
		m := &waConsumerApplication.ConsumerApplication_AudioMessage{PTT: proto.Bool(false)}
		err = m.Set(&waMediaTransport.AudioTransport{Integral: &waMediaTransport.AudioTransport_Integral{Transport: transport}, Ancillary: &waMediaTransport.AudioTransport_Ancillary{}})
		content.Content = &waConsumerApplication.ConsumerApplication_Content_AudioMessage{AudioMessage: m}
	default:
		m := &waConsumerApplication.ConsumerApplication_DocumentMessage{FileName: &file.Name}
		err = m.Set(&waMediaTransport.DocumentTransport{Integral: &waMediaTransport.DocumentTransport_Integral{Transport: transport}, Ancillary: &waMediaTransport.DocumentTransport_Ancillary{}})
		content.Content = &waConsumerApplication.ConsumerApplication_Content_DocumentMessage{DocumentMessage: m}
	}
	if err != nil {
		return nil, err
	}
	return wrapContent(content), nil
}
func decodeConsumer(data []byte) (*waConsumerApplication.ConsumerApplication, error) {
	var c waConsumerApplication.ConsumerApplication
	if proto.Unmarshal(data, &c) != nil {
		return nil, errors.New("invalid_cached_message")
	}
	return &c, nil
}
func jsonBytes(value any) []byte { data, _ := json.Marshal(value); return data }
