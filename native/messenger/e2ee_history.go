package main

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix/securehistory"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waArmadilloBackupMessage"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func (w *encryptedWorker) hasHistory() bool {
	var device securehistory.Device
	return w.store.private(w.ctx, "history-device", &device) == nil && device.ID != ""
}
func (w *encryptedWorker) recoverHistory(ctx context.Context, command workerCommand) {
	reject := func(code string, remaining *int) {
		value := map[string]any{"ok": false, "error": code, "attempted": false}
		if remaining != nil {
			value["attemptsRemaining"] = *remaining
		}
		w.response(command.ID, value)
	}
	if w.hasHistory() {
		w.response(command.ID, map[string]any{"ok": true, "historyReady": true})
		return
	}
	history := w.client.GetSecureHistoryClient()
	var enrollment securehistory.Enrollment
	if w.store.private(ctx, "pending-history", &enrollment) != nil {
		if !regexp.MustCompile(`^[0-9]{6}$`).MatchString(command.Pin) {
			reject("six_digit_pin_required", nil)
			return
		}
		pin := []byte(command.Pin)
		command.Pin = ""
		defer clear(pin)
		backup, err := history.GetBackup(ctx)
		if err != nil {
			reject("history_backup_unavailable", nil)
			return
		}
		recovery, err := history.RecoverPIN(ctx, backup, pin)
		clear(pin)
		if err != nil {
			var denied *securehistory.RecoveryError
			if errors.As(err, &denied) {
				reject("history_pin_rejected", denied.AttemptsRemaining)
			} else {
				reject("history_recovery_failed", nil)
			}
			return
		}
		virtual, err := history.GetVirtualDevice(ctx, backup, w.viewer, recovery.Code)
		if err != nil {
			reject("history_recovery_failed", nil)
			return
		}
		epochs, err := virtual.DeriveEpochs()
		if err != nil {
			reject("history_recovery_failed", nil)
			return
		}
		prepared, err := virtual.PrepareDevice(backup.ID, history.RegistrationID, w.wa.Store.IdentityKey, epochs)
		if err != nil {
			reject("history_recovery_failed", nil)
			return
		}
		enrollment = *prepared
		// Preserve the prepared device before the external enrollment. A later explicit retry reuses it.
		if w.store.putPrivate(ctx, "pending-history", enrollment) != nil {
			reject("encrypted_store_failed", nil)
			return
		}
	}
	device, err := history.AddDevice(ctx, &enrollment)
	if err != nil {
		w.response(command.ID, map[string]any{"ok": false, "error": "history_enrollment_uncertain", "attempted": true})
		return
	}
	if w.store.putPrivate(ctx, "history-device", device) != nil {
		w.response(command.ID, map[string]any{"ok": false, "error": "history_enrollment_uncertain", "attempted": true})
		return
	}
	w.store.db.ExecContext(ctx, `DELETE FROM relay_private WHERE name='pending-history'`)
	w.response(command.ID, map[string]any{"ok": true, "historyReady": true})
}
func (w *encryptedWorker) history(ctx context.Context, command workerCommand, jid waTypes.JID) {
	reject := func(code string) {
		w.response(command.ID, map[string]any{"ok": false, "error": code, "attempted": false})
	}
	var device securehistory.Device
	if w.store.private(ctx, "history-device", &device) != nil || device.ID == "" {
		reject("history_pin_required")
		return
	}
	threadInfo := w.threadFor(jid)
	historyID := threadInfo.SourceID
	if historyID == "" {
		historyID = command.ThreadID
	}
	timestamp := command.Timestamp
	if timestamp <= 0 {
		timestamp = time.Now().UnixMilli()
	}
	page, err := w.client.GetSecureHistoryClient().FetchMessages(ctx, &device, historyID, true, timestamp, 100)
	if err != nil {
		reject("history_fetch_failed")
		return
	}
	messages, err := page.Decrypt(&device, historyID, w.viewer, jid.Server == waTypes.GroupServer)
	if err != nil {
		reject("history_decryption_failed")
		return
	}
	if w.store.putPrivate(ctx, "history-device", device) != nil {
		reject("encrypted_store_failed")
		return
	}
	rows := []message{}
	for _, item := range messages {
		if item == nil || item.Message == nil {
			continue
		}
		decoded, err := decodeArchived(item.Message.Message, item.Message.TimestampMS, jid, w.viewer)
		if err != nil {
			reject("history_decode_failed")
			return
		}
		if decoded == nil {
			continue
		}
		if !w.receive(decoded, false) {
			reject("encrypted_store_failed")
			return
		}
		// Edits, reactions and revocations are folded into the original record rather than displayed as invented messages.
		for _, supplement := range item.Supplementals {
			if supplement == nil {
				continue
			}
			event, e := decodeArchived(supplement.Message, supplement.TimestampMS, jid, w.viewer)
			if e != nil {
				reject("history_decode_failed")
				return
			}
			if event != nil && !w.receive(event, false) {
				reject("encrypted_store_failed")
				return
			}
		}
		record, e := w.record(jid.User, decoded.Info.ID)
		if e == nil {
			rows = append(rows, record.Wire)
		}
	}
	hasMore := true
	if page.Range != nil && page.Range.HasMoreBefore != nil {
		hasMore = *page.Range.HasMoreBefore
	}
	next := int64(0)
	if page.Range != nil {
		next = page.Range.Before
	}
	w.response(command.ID, map[string]any{"ok": true, "threads": []*thread{threadInfo}, "messages": rows, "hasMore": hasMore, "before": next})
}
func decodeArchived(message *waArmadilloBackupMessage.BackupMessage, timestamp int64, chat waTypes.JID, viewer int64) (*events.FBMessage, error) {
	if message == nil {
		return nil, nil
	}
	payload, ok := message.GetPayload().(*waArmadilloBackupMessage.BackupMessage_EncryptedTransportMessage)
	if !ok {
		return nil, nil
	}
	var application waMsgApplication.MessageApplication
	if proto.Unmarshal(payload.EncryptedTransportMessage, &application) != nil {
		return nil, errors.New("invalid_archive")
	}
	event, err := whatsmeow.DecodeFBApplication(&application)
	if err != nil {
		return nil, err
	}
	metadata := message.GetMetadata()
	if metadata.GetMessageID() == "" || metadata.GetSenderID() == "" {
		return nil, errors.New("invalid_archive")
	}
	event.Info = waTypes.MessageInfo{MessageSource: waTypes.MessageSource{Chat: chat, Sender: waTypes.NewJID(metadata.GetSenderID(), waTypes.MessengerServer), IsFromMe: metadata.GetSenderID() == strconv.FormatInt(viewer, 10), IsGroup: chat.Server == waTypes.GroupServer}, ID: metadata.GetMessageID(), Timestamp: time.UnixMilli(timestamp)}
	return &event, nil
}
func (w *encryptedWorker) snapshot(ctx context.Context) ([]message, error) {
	result := []message{}
	rows, err := w.store.db.QueryContext(ctx, `SELECT wire FROM relay_messages ORDER BY ts DESC LIMIT 5000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var total int
	for rows.Next() {
		var data []byte
		if rows.Scan(&data) != nil {
			return nil, errors.New("snapshot_failed")
		}
		total += len(data)
		if total > 25*1024*1024 {
			break
		}
		var m message
		if json.Unmarshal(data, &m) != nil {
			return nil, errors.New("snapshot_failed")
		}
		result = append(result, m)
	}
	return result, rows.Err()
}
