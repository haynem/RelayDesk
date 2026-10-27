package main

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waMediaTransport"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

type storedFB struct {
	Chat      string            `json:"chat"`
	Sender    string            `json:"sender"`
	ID        string            `json:"id"`
	Timestamp int64             `json:"timestamp"`
	Mine      bool              `json:"mine"`
	Content   []byte            `json:"content"`
	Wire      message           `json:"wire"`
	Actors    map[string]string `json:"actors"`
}
type storedControl struct {
	Thread    string
	Target    string
	Actor     string
	Kind      string
	Timestamp int64
	Text      string
}

func (w *encryptedWorker) record(threadID, id string) (*storedFB, error) {
	var data []byte
	if err := w.store.db.QueryRowContext(w.ctx, `SELECT event FROM relay_messages WHERE thread_id=? AND id=?`, threadID, id).Scan(&data); err != nil {
		return nil, err
	}
	var record storedFB
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, err
	}
	return &record, nil
}
func (w *encryptedWorker) save(record *storedFB) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	wire, err := json.Marshal(record.Wire)
	if err != nil {
		return err
	}
	_, err = w.store.db.ExecContext(w.ctx, `INSERT INTO relay_messages(thread_id,id,ts,event,wire) VALUES(?,?,?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET ts=excluded.ts,event=excluded.event,wire=excluded.wire`, record.Wire.ThreadID, record.ID, record.Timestamp, data, wire)
	return err
}
func (w *encryptedWorker) receive(event *events.FBMessage, deliver bool) bool {
	consumer := event.GetConsumerApplication()
	if consumer == nil {
		return w.receivePlaceholder(event, deliver)
	}
	content := consumer.GetPayload().GetContent()
	if r := content.GetReactionMessage(); r != nil {
		return w.control(storedControl{Thread: event.Info.Chat.User, Target: r.GetKey().GetID(), Actor: event.Info.Sender.User, Kind: "reaction", Timestamp: event.Info.Timestamp.UnixMilli(), Text: r.GetText()}, deliver)
	}
	if edit := content.GetEditMessage(); edit != nil {
		return w.control(storedControl{Thread: event.Info.Chat.User, Target: edit.GetKey().GetID(), Actor: event.Info.Sender.User, Kind: "edit", Timestamp: event.Info.Timestamp.UnixMilli(), Text: edit.GetMessage().GetText()}, deliver)
	}
	if revoke := consumer.GetPayload().GetApplicationData().GetRevoke(); revoke != nil {
		return w.control(storedControl{Thread: event.Info.Chat.User, Target: revoke.GetKey().GetID(), Actor: event.Info.Sender.User, Kind: "delete", Timestamp: event.Info.Timestamp.UnixMilli()}, deliver)
	}
	encoded, err := proto.Marshal(consumer)
	if err != nil {
		return false
	}
	record := &storedFB{Chat: event.Info.Chat.String(), Sender: event.Info.Sender.String(), ID: event.Info.ID, Timestamp: event.Info.Timestamp.UnixMilli(), Mine: event.Info.IsFromMe, Content: encoded, Actors: map[string]string{}}
	sender := w.names[event.Info.Sender.User]
	if sender == "" {
		sender = event.Info.Sender.User
	}
	if record.Mine {
		sender = "自分"
	}
	wire := message{ID: record.ID, ThreadID: event.Info.Chat.User, Sender: sender, SenderID: event.Info.Sender.User, Timestamp: record.Timestamp, IsMe: record.Mine, RemoteJID: record.Chat, Attachments: []attachment{}}
	if event.FBApplication != nil {
		wire.ReplyTo = event.FBApplication.GetMetadata().GetQuotedMessage().GetStanzaID()
	}
	if text := content.GetMessageText(); text != nil {
		wire.Text = text.GetText()
	} else if extended := content.GetExtendedTextMessage(); extended != nil {
		wire.Text = extended.GetText().GetText()
	} else {
		transport, kind, name, caption, err := fbMedia(content)
		if err == nil && transport != nil {
			mime := transport.GetAncillary().GetMimetype()
			if mime == "" {
				mime = string(kind)
			}
			size := transport.GetAncillary().GetFileLength()
			ref, _ := json.Marshal(map[string]any{"threadId": wire.ThreadID, "messageId": wire.ID, "index": 0})
			wire.Attachments = []attachment{{Name: name, Kind: mime, Size: int64(size), RemoteID: "e2ee:" + string(ref)}}
			wire.Text = caption
		} else if location := content.GetLocationMessage(); location != nil {
			wire.Text = location.GetAddress()
		} else {
			wire.Unavailable = true
			wire.Text = "このメッセージ形式の本文は元のMessengerで確認できます"
		}
	}
	record.Wire = wire
	prior, err := w.record(wire.ThreadID, wire.ID)
	if err == nil {
		record.Actors = prior.Actors
		if prior.Wire.Deleted {
			record.Wire = prior.Wire
		}
	}
	if w.applyControls(record) != nil || w.save(record) != nil {
		return false
	}
	t := w.threadFor(event.Info.Chat)
	t.UpdatedAt = wire.Timestamp
	if deliver {
		return w.deliver(record.Wire, t)
	}
	return true
}
func (w *encryptedWorker) receivePlaceholder(event *events.FBMessage, deliver bool) bool {
	sender := w.names[event.Info.Sender.User]
	if sender == "" {
		sender = event.Info.Sender.User
	}
	wire := message{ID: event.Info.ID, ThreadID: event.Info.Chat.User, Sender: sender, SenderID: event.Info.Sender.User, Timestamp: event.Info.Timestamp.UnixMilli(), IsMe: event.Info.IsFromMe, RemoteJID: event.Info.Chat.String(), Unavailable: true, Text: "拡張メッセージ（元のMessengerで表示）", Attachments: []attachment{}}
	record := &storedFB{Chat: event.Info.Chat.String(), Sender: event.Info.Sender.String(), ID: event.Info.ID, Timestamp: wire.Timestamp, Mine: wire.IsMe, Wire: wire, Actors: map[string]string{}}
	if w.save(record) != nil {
		return false
	}
	if deliver {
		return w.deliver(wire, w.threadFor(event.Info.Chat))
	}
	return true
}
func (w *encryptedWorker) control(control storedControl, deliver bool) bool {
	if control.Target == "" {
		return false
	}
	data, _ := json.Marshal(control)
	_, err := w.store.db.ExecContext(w.ctx, `INSERT INTO relay_controls(thread_id,target,actor,kind,ts,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,target,actor,kind) DO UPDATE SET ts=excluded.ts,payload=excluded.payload WHERE excluded.ts>=relay_controls.ts`, control.Thread, control.Target, control.Actor, control.Kind, control.Timestamp, data)
	if err != nil {
		return false
	}
	record, err := w.record(control.Thread, control.Target)
	if err != nil {
		return true
	}
	if w.applyControls(record) != nil || w.save(record) != nil {
		return false
	}
	if deliver {
		jid, e := waTypes.ParseJID(record.Chat)
		if e != nil {
			return false
		}
		return w.deliver(record.Wire, w.threadFor(jid))
	}
	return true
}
func (w *encryptedWorker) applyControls(record *storedFB) error {
	rows, err := w.store.db.QueryContext(w.ctx, `SELECT payload FROM relay_controls WHERE thread_id=? AND target=? ORDER BY ts`, record.Wire.ThreadID, record.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	if record.Actors == nil {
		record.Actors = map[string]string{}
	}
	for rows.Next() {
		var data []byte
		if rows.Scan(&data) != nil {
			return errors.New("control_read_failed")
		}
		var c storedControl
		if json.Unmarshal(data, &c) != nil {
			return errors.New("control_read_failed")
		}
		sender, e := waTypes.ParseJID(record.Sender)
		if e != nil {
			return e
		}
		switch c.Kind {
		case "reaction":
			record.Actors[c.Actor] = c.Text
		case "edit":
			if c.Actor == sender.User && !record.Wire.Deleted && c.Timestamp > record.Wire.EditedAt {
				record.Wire.Text = c.Text
				record.Wire.EditedAt = c.Timestamp
				record.Wire.Revision++
			}
		case "delete":
			if c.Actor == sender.User {
				record.Wire.Text = ""
				record.Wire.Attachments = []attachment{}
				record.Wire.Deleted = true
			}
		}
	}
	reactions := map[string]*reaction{}
	for actor, emoji := range record.Actors {
		if emoji == "" {
			continue
		}
		r := reactions[emoji]
		if r == nil {
			r = &reaction{Name: emoji}
			reactions[emoji] = r
		}
		r.Count++
		if actor == strconv.FormatInt(w.viewer, 10) {
			r.Mine = true
		}
	}
	record.Wire.Reactions = []reaction{}
	for _, r := range reactions {
		record.Wire.Reactions = append(record.Wire.Reactions, *r)
	}
	return rows.Err()
}
func fbMedia(content *waConsumerApplication.ConsumerApplication_Content) (*waMediaTransport.WAMediaTransport, whatsmeow.MediaType, string, string, error) {
	if m := content.GetImageMessage(); m != nil {
		t, e := m.Decode()
		return t.GetIntegral().GetTransport(), whatsmeow.MediaImage, "画像", m.GetCaption().GetText(), e
	}
	if m := content.GetVideoMessage(); m != nil {
		t, e := m.Decode()
		return t.GetIntegral().GetTransport(), whatsmeow.MediaVideo, "動画", m.GetCaption().GetText(), e
	}
	if m := content.GetAudioMessage(); m != nil {
		t, e := m.Decode()
		return t.GetIntegral().GetTransport(), whatsmeow.MediaAudio, "音声", "", e
	}
	if m := content.GetDocumentMessage(); m != nil {
		t, e := m.Decode()
		return t.GetIntegral().GetTransport(), whatsmeow.MediaDocument, m.GetFileName(), "", e
	}
	if m := content.GetStickerMessage(); m != nil {
		t, e := m.Decode()
		return t.GetIntegral().GetTransport(), whatsmeow.MediaImage, "スタンプ", "", e
	}
	return nil, "", "", "", errors.New("not_media")
}
func (w *encryptedWorker) download(ctx context.Context, record *storedFB) ([]byte, error) {
	var consumer waConsumerApplication.ConsumerApplication
	if proto.Unmarshal(record.Content, &consumer) != nil {
		return nil, errors.New("invalid_cached_message")
	}
	transport, kind, _, _, err := fbMedia(consumer.GetPayload().GetContent())
	if err != nil || transport == nil {
		return nil, errors.New("attachment_unavailable")
	}
	if transport.GetAncillary().GetFileLength() > 25*1024*1024 {
		return nil, errors.New("attachment_too_large")
	}
	data, err := w.wa.DownloadFB(ctx, transport.GetIntegral(), kind)
	if len(data) > 25*1024*1024 {
		return nil, errors.New("attachment_too_large")
	}
	return data, err
}

// Ephemeral plaintext is passed only over the parent's private pipe. It is never written to disk here.
func (w *encryptedWorker) sendEventCopy(ctx context.Context, jid waTypes.JID, id, replyTo string, consumer *waConsumerApplication.ConsumerApplication) bool {
	if !w.receive(&events.FBMessage{Info: waTypes.MessageInfo{MessageSource: waTypes.MessageSource{Chat: jid, Sender: w.wa.Store.ID.ToNonAD(), IsFromMe: true, IsGroup: jid.Server == waTypes.GroupServer}, ID: id, Timestamp: time.Now()}, Message: consumer}, false) {
		return false
	}
	record, err := w.record(jid.User, id)
	if err != nil {
		return false
	}
	record.Wire.ReplyTo = replyTo
	if w.save(record) != nil {
		return false
	}
	return w.deliver(record.Wire, w.threadFor(jid))
}
