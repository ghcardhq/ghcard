package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCreateCardSendsKeyAndParsesCardAndRateLimit(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/cards" {
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "99")
		w.Header().Set("X-RateLimit-Reset", "1793318400")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"success":true,"data":{"id":"abc","created":true,"subject":"octocat","url":"https://x/g/p.svg","urls":{"svg":"https://x/g/p.svg","png":"https://x/g/p.png"},"embed":{"markdown":"m","html":"h"},"usage":{"used":1,"limit":100,"remaining":99}}}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "ghc_live_1_key", "test")
	card, limit, err := c.CreateCard(context.Background(), CardRequest{Username: "octocat", Template: "social"})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer ghc_live_1_key" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotBody["username"] != "octocat" || gotBody["template"] != "social" {
		t.Fatalf("body = %v", gotBody)
	}
	if _, sent := gotBody["watermark"]; sent {
		t.Fatal("unset watermark must be omitted so the server default applies")
	}
	if !card.Created || card.ID != "abc" || card.URLs.PNG != "https://x/g/p.png" || card.Usage.Remaining != 99 {
		t.Fatalf("card = %+v", card)
	}
	if limit == nil || limit.Remaining != 99 || !limit.Reset.Equal(time.Unix(1793318400, 0)) {
		t.Fatalf("limit = %+v", limit)
	}
}

func TestErrorsCarryCodeRetryableAndRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"success":false,"code":"QUOTA_EXCEEDED","message":"Daily card quota of 100 reached.","retryable":true,"limit":100,"resetAt":"2026-10-31T00:00:00.000Z"}`))
	}))
	defer srv.Close()

	_, _, err := New(srv.URL, "k", "t").CreateCard(context.Background(), CardRequest{Username: "octocat"})
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v", err)
	}
	if apiErr.Status != 429 || apiErr.Code != "QUOTA_EXCEEDED" || !apiErr.Retryable || apiErr.RetryAfter != 2*time.Minute {
		t.Fatalf("apiErr = %+v", apiErr)
	}
	if apiErr.Details["limit"] != float64(100) {
		t.Fatalf("details = %v", apiErr.Details)
	}
}

func TestErrorWithoutCodeGetsOneFromStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Unauthorized","message":"Invalid API key"}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "k", "t").Usage(context.Background())
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != "UNAUTHORIZED" || apiErr.Message != "Invalid API key" {
		t.Fatalf("err = %#v", err)
	}
}

func TestKeyRequiredBeforeAnyRequest(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer srv.Close()

	_, err := New(srv.URL, "", "t").ListCards(context.Background(), 10, "")
	if !errors.Is(err, ErrNoAPIKey) || called {
		t.Fatalf("err = %v, called = %v", err, called)
	}
}

func TestCatalogueNeedsNoKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Fatal("catalogue request must not send the key")
		}
		if r.URL.Query().Get("scope") != "repo" {
			t.Fatalf("scope = %q", r.URL.Query().Get("scope"))
		}
		_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"repo-og-compact","scope":"repo","pro":false}]}`))
	}))
	defer srv.Close()

	templates, err := New(srv.URL, "", "t").Templates(context.Background(), "repo")
	if err != nil || len(templates) != 1 || templates[0].ID != "repo-og-compact" {
		t.Fatalf("templates = %v, err = %v", templates, err)
	}
}

func TestNetworkFailureIsRetryable(t *testing.T) {
	c := New("http://127.0.0.1:1", "k", "t")
	c.HTTPClient.Timeout = time.Second
	_, err := c.Usage(context.Background())
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != "NETWORK_ERROR" || !apiErr.Retryable {
		t.Fatalf("err = %#v", err)
	}
}
