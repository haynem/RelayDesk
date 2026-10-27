// RelayDesk private IPC adapter. No cookies, plaintext databases or logs are written to disk.
package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/rs/zerolog"
	globalLog "github.com/rs/zerolog/log"
	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
)

type input struct {
	Version       int        `json:"version"`
	Mode          string     `json:"mode"`
	ViewerID      string     `json:"viewerId"`
	ThreadID      string     `json:"threadId"`
	MessageID     string     `json:"messageId"`
	Timestamp     int64      `json:"timestamp"`
	Text          string     `json:"text"`
	ExpectedText  string     `json:"expectedText"`
	ReplyTo       string     `json:"replyTo"`
	Emoji         string     `json:"emoji"`
	OperationID   string     `json:"operationId"`
	Approved      bool       `json:"approved"`
	StorePath     string     `json:"storePath"`
	StoreKey      string     `json:"storeKey"`
	AllowRegister bool       `json:"allowRegister"`
	Files         []sendFile `json:"files"`
	Cookies       []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"cookies"`
}
type thread struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	IsGroup      bool     `json:"isGroup"`
	UpdatedAt    int64    `json:"updatedAt"`
	Members      []string `json:"members"`
	Encrypted    bool     `json:"encrypted"`
	SourceUnread *bool    `json:"sourceUnread,omitempty"`
	RemoteJID    string   `json:"remoteJid,omitempty"`
	SourceID     string   `json:"sourceId,omitempty"`
}
type message struct {
	ID          string       `json:"id"`
	ThreadID    string       `json:"threadId"`
	Sender      string       `json:"sender"`
	Text        string       `json:"text"`
	Timestamp   int64        `json:"ts"`
	IsMe        bool         `json:"isMe"`
	ReplyTo     string       `json:"replyTo,omitempty"`
	Deleted     bool         `json:"deleted,omitempty"`
	Revision    int64        `json:"revision,omitempty"`
	SenderID    string       `json:"senderId,omitempty"`
	RemoteJID   string       `json:"remoteJid,omitempty"`
	EditedAt    int64        `json:"editedAt,omitempty"`
	Unavailable bool         `json:"unavailable,omitempty"`
	Reactions   []reaction   `json:"reactions,omitempty"`
	Attachments []attachment `json:"attachments,omitempty"`
}
type output struct {
	OK                   bool                              `json:"ok"`
	Error                string                            `json:"error,omitempty"`
	ViewerID             string                            `json:"viewerId,omitempty"`
	Threads              []*thread                         `json:"threads"`
	Messages             []message                         `json:"messages"`
	EncryptedWithoutBody int                               `json:"encryptedWithoutBody"`
	RemoteID             string                            `json:"remoteId,omitempty"`
	Confirmed            bool                              `json:"confirmed,omitempty"`
	Cookies              map[cookies.MetaCookieName]string `json:"cookies,omitempty"`
}

func normalize(ls *table.LSTable, viewer int64) output {
	out := output{OK: true, ViewerID: strconv.FormatInt(viewer, 10), Threads: []*thread{}, Messages: []message{}}
	contacts := map[int64]string{}
	for _, c := range ls.LSDeleteThenInsertContact {
		contacts[c.Id] = c.Name
	}
	threads := map[int64]*thread{}
	watermarks := map[int64]int64{}
	add := func(info table.ThreadInfo, activity int64) {
		id := info.GetThreadKey()
		title := info.GetThreadName()
		if title == "" {
			title = contacts[id]
		}
		if title == "" {
			title = "Messengerの会話"
		}
		threads[id] = &thread{ID: strconv.FormatInt(id, 10), Title: title, IsGroup: !info.GetThreadType().IsOneToOne(), UpdatedAt: activity, Members: []string{}, Encrypted: info.GetThreadType().IsWhatsApp()}
		watermarks[id] = info.GetLastReadWatermarkTimestampMs()
	}
	for _, t := range ls.LSDeleteThenInsertThread {
		add(t, t.LastActivityTimestampMs)
	}
	for _, t := range ls.LSUpdateOrInsertThread {
		add(t, t.LastActivityTimestampMs)
	}
	raw := append([]*table.LSInsertMessage{}, ls.LSInsertMessage...)
	for _, m := range ls.LSUpsertMessage {
		raw = append(raw, m.ToInsert())
	}
	seen := map[string]bool{}
	received := map[int64]int64{}
	messageCount := map[int64]int{}
	for _, m := range raw {
		if m.MessageId == "" || seen[m.MessageId] {
			continue
		}
		seen[m.MessageId] = true
		t := threads[m.ThreadKey]
		if t == nil {
			t = &thread{ID: strconv.FormatInt(m.ThreadKey, 10), Title: "Messengerの会話", Members: []string{}}
			threads[m.ThreadKey] = t
		}
		sender := contacts[m.SenderId]
		if m.SenderId == viewer {
			sender = "自分"
		}
		if sender == "" {
			sender = "不明"
		}
		out.Messages = append(out.Messages, message{ID: m.MessageId, ThreadID: t.ID, Sender: sender, Text: m.Text, Timestamp: m.TimestampMs, IsMe: m.SenderId == viewer, ReplyTo: m.ReplySourceId, Deleted: m.IsUnsent, Revision: m.EditCount})
		if m.TimestampMs > t.UpdatedAt {
			t.UpdatedAt = m.TimestampMs
		}
		messageCount[m.ThreadKey]++
		if !m.IsUnsent && m.SenderId != viewer && m.TimestampMs > received[m.ThreadKey] {
			received[m.ThreadKey] = m.TimestampMs
		}
	}
	for id, t := range threads {
		if watermarks[id] > 0 && messageCount[id] > 0 {
			unread := received[id] > watermarks[id]
			t.SourceUnread = &unread
		}
		if t.Encrypted && messageCount[id] == 0 {
			out.EncryptedWithoutBody++
		}
		out.Threads = append(out.Threads, t)
	}
	addAttachments(&out, ls)
	decorateEncryptedCatalog(ls, &out)
	for i := range out.Messages {
		if out.Messages[i].Deleted {
			out.Messages[i].Text = ""
			out.Messages[i].Attachments = nil
		}
	}
	return out
}

func run() (result output) {
	var request input
	if json.NewDecoder(io.LimitReader(os.Stdin, 145*1024*1024)).Decode(&request) != nil || request.Version != 1 {
		return output{Error: "invalid_request"}
	}
	cookieMap := map[cookies.MetaCookieName]string{}
	for _, c := range request.Cookies {
		cookieMap[cookies.MetaCookieName(c.Name)] = c.Value
	}
	jar := &cookies.Cookies{Platform: types.Facebook}
	jar.UpdateValues(cookieMap)
	if len(jar.GetMissingCookieNames()) > 0 {
		return output{Error: "missing_cookies"}
	}
	viewer := jar.GetUserID()
	if strconv.FormatInt(viewer, 10) != request.ViewerID {
		return output{Error: "identity_mismatch"}
	}
	defer func() {
		if result.OK && jar.GetUserID() == viewer {
			result.Cookies = jar.GetAll()
		}
	}()
	client := messagix.NewClient(jar, zerolog.Nop(), &messagix.Config{})
	duration := 50 * time.Second
	if request.Mode != "read" {
		duration = 180 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()
	user, ls, err := client.LoadMessagesPage(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return output{Error: "timeout"}
		}
		return output{Error: "read_failed"}
	}
	if user == nil || user.GetFBID() != viewer {
		return output{Error: "identity_mismatch"}
	}
	if ls == nil {
		return output{Error: "schema_changed"}
	}
	if request.Mode == "read" {
		return normalize(ls, viewer)
	}
	if request.Mode == "e2ee-worker" {
		return runEncryptedWorker(client, ls, viewer, request)
	}
	return operate(ctx, client, ls, viewer, request)
}
func main() {
	destination := os.Stdout
	privateOutput = destination
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err == nil {
		os.Stdout = null
		os.Stderr = null
		defer null.Close()
	}
	log.SetOutput(io.Discard)
	globalLog.Logger = zerolog.Nop()
	var result output
	func() {
		defer func() {
			if recover() != nil {
				result = output{Error: "internal_error"}
			}
		}()
		result = run()
	}()
	// This stream is private IPC read directly by the parent, never a debug log.
	_ = json.NewEncoder(destination).Encode(result)
}
