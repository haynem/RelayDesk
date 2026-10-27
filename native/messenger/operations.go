package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/httpclient"
	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

type sendFile struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
	Data []byte `json:"data"`
}
type attachment struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	URL      string `json:"url,omitempty"`
	Size     int64  `json:"size,omitempty"`
	RemoteID string `json:"remoteId,omitempty"`
}

func addAttachments(out *output, ls *table.LSTable) {
	positions := map[string]int{}
	for i, m := range out.Messages {
		positions[m.ThreadID+":"+m.ID] = i
	}
	add := func(thread int64, id, name, mime, url string, size int64) {
		i, ok := positions[strconv.FormatInt(thread, 10)+":"+id]
		if !ok {
			return
		}
		if name == "" {
			name = "Messenger添付"
		}
		if mime == "" {
			mime = "application/octet-stream"
		}
		if !strings.HasPrefix(url, "https://") {
			url = ""
		}
		out.Messages[i].Attachments = append(out.Messages[i].Attachments, attachment{Name: name, Kind: mime, URL: url, Size: size})
	}
	for _, f := range ls.LSInsertAttachment {
		url := f.PlayableUrl
		if url == "" {
			url = f.ImageUrl
		}
		if url == "" {
			url = f.PreviewUrl
		}
		add(f.ThreadKey, f.MessageId, f.Filename, f.AttachmentMimeType, url, f.Filesize)
	}
	for _, f := range ls.LSInsertBlobAttachment {
		url := f.PlayableUrl
		if url == "" {
			url = f.PreviewUrl
		}
		add(f.ThreadKey, f.MessageId, f.Filename, f.AttachmentMimeType, url, f.Filesize)
	}
	for _, f := range ls.LSInsertStickerAttachment {
		url := f.PlayableUrl
		if url == "" {
			url = f.PreviewUrl
		}
		add(f.ThreadKey, f.MessageId, "スタンプ", "image/webp", url, 0)
	}
}
func operate(ctx context.Context, client *messagix.Client, initial *table.LSTable, viewer int64, request input) output {
	allowed := map[string]bool{"history": true, "send": true, "edit": true, "delete": true, "react-add": true, "react-remove": true, "receipt": true}
	if !allowed[request.Mode] || request.Mode != "history" && (!request.Approved || request.OperationID == "") {
		return output{Error: "approval_required"}
	}
	threadID, err := strconv.ParseInt(request.ThreadID, 10, 64)
	if err != nil || threadID <= 0 {
		return output{Error: "invalid_thread"}
	}
	base := normalize(initial, viewer)
	var target *thread
	for _, t := range base.Threads {
		if t.ID == request.ThreadID {
			target = t
			break
		}
	}
	// Encrypted Messenger threads require the separate WhatsApp transport and linked device keys.
	if target == nil || target.Encrypted {
		return output{Error: "encrypted_or_unavailable_thread"}
	}
	var guard sync.Mutex
	tables := []*table.LSTable{}
	notify := make(chan struct{}, 1)
	client.SetEventHandler(func(eventCtx context.Context, event any) {
		if payload, ok := event.(*messagix.PublishResponseData); ok {
			parsed, e := payload.Parse(eventCtx)
			if e == nil {
				guard.Lock()
				if len(tables) < 40 {
					tables = append(tables, parsed)
				}
				guard.Unlock()
				select {
				case notify <- struct{}{}:
				default:
				}
			}
		}
	})
	if client.Connect(ctx) != nil {
		return output{Error: "connect_failed"}
	}
	defer client.Disconnect()
	if client.WaitUntilCanSendMessages(ctx, 15*time.Second) != nil {
		return output{Error: "connect_failed"}
	}
	if request.Mode == "history" {
		if request.Timestamp <= 0 || request.MessageID == "" {
			return output{Error: "invalid_history_cursor"}
		}
		page, e := client.ExecuteTasks(ctx, &socket.FetchMessagesTask{ThreadKey: threadID, Direction: 0, ReferenceTimestampMs: request.Timestamp, ReferenceMessageId: request.MessageID, SyncGroup: 1, Cursor: client.GetCursor(1)})
		if e != nil {
			return output{Error: "history_failed"}
		}
		if page != nil {
			guard.Lock()
			tables = append(tables, page)
			guard.Unlock()
		}
		// Some servers deliver the history page on the socket after the task response.
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return output{Error: "timeout"}
		}
		result := output{OK: true, ViewerID: request.ViewerID, Threads: []*thread{}, Messages: []message{}}
		guard.Lock()
		defer guard.Unlock()
		seen := map[string]bool{}
		for _, ls := range tables {
			copy := *ls
			copy.LSDeleteThenInsertContact = append(initial.LSDeleteThenInsertContact, ls.LSDeleteThenInsertContact...)
			parsed := normalize(&copy, viewer)
			for _, m := range parsed.Messages {
				if m.ThreadID == request.ThreadID && !seen[m.ID] {
					result.Messages = append(result.Messages, m)
					seen[m.ID] = true
				}
			}
		}
		if len(result.Messages) == 0 {
			return output{Error: "history_result_unknown"}
		}
		return result
	}
	if request.Mode == "send" {
		if len(request.Text) > 40000 || len(request.Files) > 10 || strings.TrimSpace(request.Text) == "" && len(request.Files) == 0 {
			return output{Error: "invalid_content"}
		}
		attachments := []int64{}
		var total int
		for _, f := range request.Files {
			total += len(f.Data)
			if len(f.Data) > 25*1024*1024 || total > 100*1024*1024 || f.Name == "" {
				return output{Error: "invalid_file"}
			}
		}
		for _, f := range request.Files {
			uploaded, e := client.GetHTTP().SendMercuryUploadRequest(ctx, threadID, &httpclient.MercuryUploadMedia{Filename: f.Name, MimeType: f.Mime, MediaData: f.Data})
			if e != nil || uploaded == nil || uploaded.Payload.RealMetadata == nil {
				return output{Error: "upload_result_unknown"}
			}
			id := uploaded.Payload.RealMetadata.GetFbId()
			if id == 0 {
				return output{Error: "upload_result_unknown"}
			}
			attachments = append(attachments, id)
		}
		var random [8]byte
		if _, e := rand.Read(random[:]); e != nil {
			return output{Error: "internal_error"}
		}
		otid := (time.Now().UnixMilli() << 22) | (int64(binary.BigEndian.Uint64(random[:])) & 0x3fffff)
		task := &socket.SendMessageTask{ThreadId: threadID, Otid: otid, Source: table.MESSENGER_INBOX_IN_THREAD, InitiatingSource: table.FACEBOOK_INBOX, SendType: table.TEXT, SyncGroup: 1, Text: request.Text, SkipUrlPreviewGen: 1, AttachmentFBIds: attachments}
		if len(attachments) > 0 {
			task.SendType = table.MEDIA
		}
		if request.ReplyTo != "" {
			task.ReplyMetaData = &socket.ReplyMetaData{ReplyMessageId: request.ReplyTo, ReplySourceType: 1, ReplyType: 0}
		}
		response, e := client.ExecuteTasks(ctx, task)
		if e != nil || response == nil {
			return output{Error: "send_result_unknown"}
		}
		for _, r := range response.LSReplaceOptimsiticMessage {
			if r.OfflineThreadingId == strconv.FormatInt(otid, 10) && r.MessageId != "" {
				return output{OK: true, ViewerID: request.ViewerID, RemoteID: r.MessageId, Confirmed: true}
			}
		}
		return output{Error: "send_result_unknown"}
	}
	if request.Mode == "receipt" {
		response, e := client.ExecuteTasks(ctx, &socket.ThreadMarkReadTask{ThreadId: threadID, LastReadWatermarkTs: request.Timestamp, SyncGroup: 1})
		if e != nil || response == nil || len(response.LSHandleFailedTask) > 0 {
			return output{Error: "receipt_result_unknown"}
		}
		return output{OK: true, ViewerID: request.ViewerID, Confirmed: true}
	}
	var current *message
	for i, m := range base.Messages {
		if m.ThreadID == request.ThreadID && m.ID == request.MessageID {
			current = &base.Messages[i]
			break
		}
	}
	if current == nil || current.Text != request.ExpectedText || (request.Mode == "edit" || request.Mode == "delete") && !current.IsMe {
		return output{Error: "message_changed"}
	}
	var task socket.Task
	switch request.Mode {
	case "edit":
		if strings.TrimSpace(request.Text) == "" || len(request.Text) > 40000 {
			return output{Error: "invalid_content"}
		}
		task = &socket.EditMessageTask{MessageID: request.MessageID, Text: request.Text}
	case "delete":
		task = &socket.DeleteMessageTask{MessageId: request.MessageID}
	default:
		emoji := request.Emoji
		if request.Mode == "react-remove" {
			emoji = ""
		}
		if len(emoji) > 400 {
			return output{Error: "invalid_emoji"}
		}
		task = &socket.SendReactionTask{ThreadKey: threadID, MessageID: request.MessageID, ActorID: viewer, Reaction: emoji, ReactionStyle: 0, SendAttribution: table.MESSENGER_INBOX_IN_THREAD}
	}
	response, e := client.ExecuteTasks(ctx, task)
	if e != nil || response == nil || len(response.LSHandleFailedTask) > 0 {
		return output{Error: "action_result_unknown"}
	}
	confirmed := false
	switch request.Mode {
	case "edit":
		for _, r := range response.LSEditMessage {
			if r.MessageID == request.MessageID && r.Text == request.Text {
				confirmed = true
			}
		}
	case "delete":
		for _, r := range response.LSDeleteMessage {
			if r.MessageId == request.MessageID && r.ThreadKey == threadID {
				confirmed = true
			}
		}
	case "react-add":
		for _, r := range response.LSUpsertReaction {
			if r.MessageId == request.MessageID && r.ActorId == viewer && r.Reaction == request.Emoji {
				confirmed = true
			}
		}
	case "react-remove":
		for _, r := range response.LSDeleteReaction {
			if r.MessageId == request.MessageID && r.ActorId == viewer {
				confirmed = true
			}
		}
	}
	if !confirmed {
		return output{Error: "action_result_unknown"}
	}
	return output{OK: true, ViewerID: request.ViewerID, Confirmed: true}
}
