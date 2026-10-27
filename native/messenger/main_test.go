package main

import (
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"testing"
)

func TestNormalizePreservesIdentifiersAndDoesNotInventEncryptedBodies(t *testing.T) {
	const id int64 = 9007199254740993
	ls := &table.LSTable{
		LSDeleteThenInsertContact: []*table.LSDeleteThenInsertContact{{Id: 42, Name: "架空の相手"}},
		LSDeleteThenInsertThread:  []*table.LSDeleteThenInsertThread{{ThreadKey: id, ThreadName: "Fixture", LastActivityTimestampMs: 50, LastReadWatermarkTimestampMs: 10}},
		LSInsertMessage:           []*table.LSInsertMessage{{ThreadKey: id, MessageId: "fixture", SenderId: 42, Text: "日本語の架空メッセージ", TimestampMs: 50}, {ThreadKey: id, MessageId: "removed", IsUnsent: true}},
		LSUpsertMessage:           []*table.LSUpsertMessage{{ThreadKey: id, MessageId: "fixture", SenderId: 42, Text: "duplicate", TimestampMs: 50}},
	}
	out := normalize(ls, 99)
	if !out.OK || len(out.Messages) != 1 || len(out.Threads) != 1 {
		t.Fatal("normalization count or dedup failed")
	}
	if out.Threads[0].ID != "9007199254740993" || out.Messages[0].ThreadID != "9007199254740993" {
		t.Fatal("identifier precision lost")
	}
	if out.Messages[0].Sender != "架空の相手" || out.Messages[0].Text != "日本語の架空メッセージ" {
		t.Fatal("message mapping failed")
	}
	if out.Threads[0].SourceUnread == nil || !*out.Threads[0].SourceUnread {
		t.Fatal("read watermark lost")
	}
}
