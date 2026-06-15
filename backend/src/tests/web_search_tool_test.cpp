#include "services/tools/web_search_tool.h"

#include <atomic>
#include <chrono>
#include <filesystem>
#include <functional>
#include <future>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

#include <httplib.h>

namespace fs = std::filesystem;

namespace {

class ScopedDir {
public:
    ScopedDir() {
        path_ = fs::temp_directory_path() / ("ctrlpanel-web-search-test-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(path_);
    }

    ~ScopedDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }

    const fs::path& path() const {
        return path_;
    }

private:
    fs::path path_;
};

void expect(bool condition, const std::string& message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

void sleepForHostDelay() {
    std::this_thread::sleep_for(std::chrono::milliseconds(700));
}

} // namespace

int main() {
    try {
        httplib::Server server;
        int etagFetchCount = 0;
        int port = 0;

        server.Get("/robots.txt", [&](const httplib::Request&, httplib::Response& res) {
            const std::string body =
                "User-agent: *\n"
                "Disallow: /blocked\n"
                "Sitemap: http://127.0.0.1:" + std::to_string(port) + "/sitemap.xml\n";
            res.set_content(body, "text/plain");
        });

        server.Get("/sitemap.xml", [&](const httplib::Request&, httplib::Response& res) {
            const std::string body =
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">"
                "<url><loc>http://127.0.0.1:" + std::to_string(port) + "/article</loc></url>"
                "<url><loc>http://127.0.0.1:" + std::to_string(port) + "/duplicate</loc></url>"
                "</urlset>";
            res.set_content(body, "application/xml");
        });

        server.Get("/", [&](const httplib::Request&, httplib::Response& res) {
            const std::string body =
                "<html lang=\"en\"><head><title>Root Page</title>"
                "<meta name=\"description\" content=\"Root overview for tests\"></head>"
                "<body><main><h1>Root Page</h1>"
                "<p>Root page content with discovery links.</p>"
                "<a href=\"/article\">Article</a>"
                "<a href=\"/duplicate\">Duplicate</a>"
                "<a href=\"/blocked/secret\">Blocked</a>"
                "</main></body></html>";
            res.set_content(body, "text/html");
        });

        server.Get("/article", [&](const httplib::Request&, httplib::Response& res) {
            const std::string body =
                "<html lang=\"en\"><head><title>Crawler Article</title>"
                "<link rel=\"canonical\" href=\"http://127.0.0.1:" + std::to_string(port) + "/article\" />"
                "<meta name=\"description\" content=\"A test article for web search\"></head>"
                "<body><main><h1>Crawler Article</h1>"
                "<p>Unique retrieval keyword zebraquantum appears in this indexed article.</p>"
                "</main></body></html>";
            res.set_content(body, "text/html");
        });

        server.Get("/live-article", [&](const httplib::Request&, httplib::Response& res) {
            const std::string body =
                "<html lang=\"en\"><head><title>Live Bootstrap Article</title>"
                "<meta name=\"description\" content=\"Live fallback bootstrap article\"></head>"
                "<body><main><h1>Live Bootstrap Article</h1>"
                "<p>livebootstrapalpha lets the search fallback prove it can fetch and index remote results automatically.</p>"
                "</main></body></html>";
            res.set_content(body, "text/html");
        });

        server.Get("/live-html-article", [&](const httplib::Request&, httplib::Response& res) {
            const std::string body =
                "<html lang=\"en\"><head><title>HTML Search Bootstrap Article</title>"
                "<meta name=\"description\" content=\"DuckDuckGo-style HTML search bootstrap article\"></head>"
                "<body><main><h1>HTML Search Bootstrap Article</h1>"
                "<p>htmlsearchalpha proves the HTML live search parser can return relevant results.</p>"
                "</main></body></html>";
            res.set_content(body, "text/html");
        });

        server.Get("/large", [&](const httplib::Request&, httplib::Response& res) {
            std::string body =
                "<html lang=\"en\"><head><title>Large Page</title>"
                "<meta name=\"description\" content=\"Large response used to test truncation\"></head>"
                "<body><main><h1>Large Page</h1><p>";
            body += std::string(16384, 'x');
            body += "</p></main></body></html>";
            res.set_content(body, "text/html");
        });

        server.Get("/many-links", [&](const httplib::Request&, httplib::Response& res) {
            std::string body =
                "<html lang=\"en\"><head><title>Many Links</title></head>"
                "<body><main><h1>Many Links</h1>";
            for (int i = 0; i < 600; ++i) {
                body += "<a href=\"/many-links-target-" + std::to_string(i) + "\">Link " + std::to_string(i) + "</a>";
            }
            body += "</main></body></html>";
            res.set_content(body, "text/html");
        });

        server.Get("/slow", [&](const httplib::Request&, httplib::Response& res) {
            std::this_thread::sleep_for(std::chrono::seconds(10));
            const std::string body =
                "<html lang=\"en\"><head><title>Slow Page</title></head>"
                "<body><main><p>slow response body</p></main></body></html>";
            res.set_content(body, "text/html");
        });

        server.Get("/duplicate", [&](const httplib::Request&, httplib::Response& res) {
            const std::string body =
                "<html lang=\"en\"><head><title>Duplicate Article</title></head>"
                "<body><main><h1>Crawler Article</h1>"
                "<p>Unique retrieval keyword zebraquantum appears in this indexed article.</p>"
                "</main></body></html>";
            res.set_content(body, "text/html");
        });

        server.Get("/etag", [&](const httplib::Request& req, httplib::Response& res) {
            const std::string etag = "\"etag-v1\"";
            if (req.has_header("If-None-Match") && req.get_header_value("If-None-Match") == etag) {
                res.status = 304;
                res.set_header("ETag", etag);
                return;
            }

            ++etagFetchCount;
            const std::string body =
                "<html lang=\"en\"><head><title>ETag Page</title></head>"
                "<body><main><p>etag keyword persistence</p></main></body></html>";
            res.set_header("ETag", etag);
            res.set_content(body, "text/html");
        });

        server.Get("/blocked/secret", [&](const httplib::Request&, httplib::Response& res) {
            res.set_content("<html><body><p>Should never be indexed.</p></body></html>", "text/html");
        });

        server.Get("/search", [&](const httplib::Request& req, httplib::Response& res) {
            const std::string query = req.has_param("q") ? req.get_param_value("q") : "";
            const std::string body =
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                "<rss version=\"2.0\"><channel>"
                "<title>Local Search Feed</title>"
                "<link>http://127.0.0.1:" + std::to_string(port) + "/search?q=" + query + "</link>"
                "<description>Search results</description>"
                "<item>"
                "<title>Live Bootstrap Article</title>"
                "<link>http://127.0.0.1:" + std::to_string(port) + "/live-article</link>"
                "<description>livebootstrapalpha proves live search fallback can seed the local index.</description>"
                "<pubDate>Wed, 22 Apr 2026 08:00:00 GMT</pubDate>"
                "</item>"
                "<item>"
                "<title>ETag Page</title>"
                "<link>http://127.0.0.1:" + std::to_string(port) + "/etag</link>"
                "<description>etag keyword persistence</description>"
                "<pubDate>Wed, 22 Apr 2026 07:00:00 GMT</pubDate>"
                "</item>"
                "</channel></rss>";
            res.set_content(body, "application/rss+xml");
        });

        server.Get("/duckduckgo-html-search", [&](const httplib::Request& req, httplib::Response& res) {
            const std::string query = req.has_param("q") ? req.get_param_value("q") : "";
            const std::string encodedArticleUrl = "http%3A%2F%2F127.0.0.1%3A" + std::to_string(port) + "%2Flive-html-article";
            const std::string body =
                "<html><body><div class=\"serp__results\"><div id=\"links\" class=\"results\">"
                "<div class=\"result results_links results_links_deep web-result\">"
                "<div class=\"links_main links_deep result__body\">"
                "<h2 class=\"result__title\">"
                "<a rel=\"nofollow\" class=\"result__a\" href=\"//duckduckgo.com/l/?uddg=" + encodedArticleUrl + "&amp;rut=test\">"
                "HTML Search Bootstrap Article</a></h2>"
                "<a class=\"result__snippet\" href=\"//duckduckgo.com/l/?uddg=" + encodedArticleUrl + "&amp;rut=test\">"
                "htmlsearchalpha gives " + query + " a relevant result from the HTML live search provider.</a>"
                "</div></div></div></div></body></html>";
            res.set_content(body, "text/html");
        });

        port = server.bind_to_any_port("127.0.0.1");
        expect(port > 0, "Failed to bind test server");
        std::thread serverThread([&]() {
            server.listen_after_bind();
        });
        struct ServerGuard {
            httplib::Server& server;
            std::thread& thread;
            ~ServerGuard() {
                server.stop();
                if (thread.joinable()) {
                    thread.join();
                }
            }
        } serverGuard{server, serverThread};
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

        ScopedDir tempDir;
        WebSearchTool::Options options;
        options.storageRoot = tempDir.path().string();
        options.databasePath = (tempDir.path() / "index.sqlite3").string();
        options.enableBackgroundWorker = false;
        options.allowPrivateHosts = true;
        options.userAgent = "ctrlpanel-websearch-test/1.0";
        options.liveSearchBaseUrl = "http://127.0.0.1:" + std::to_string(port) + "/search";
        options.liveSearchBootstrapCount = 2;

        WebSearchTool tool(options);
        std::string initError;
        expect(tool.initialize(&initError), "Initialization failed: " + initError);

        Json::Value liveSearchArgs(Json::objectValue);
        liveSearchArgs["query"] = "livebootstrapalpha";
        liveSearchArgs["top_k"] = 5;
        const Json::Value liveSearchResult = tool.search(liveSearchArgs);
        expect(liveSearchResult.get("source", "").asString() == "live_fallback", "Live fallback search did not identify its source");
        expect(liveSearchResult["results"].isArray() && !liveSearchResult["results"].empty(), "Live fallback search returned no results");
        const int liveDocId = liveSearchResult["results"][0].get("doc_id", 0).asInt();
        expect(liveDocId > 0, "Live fallback did not bootstrap a doc_id");

        Json::Value liveOpenArgs(Json::objectValue);
        liveOpenArgs["doc_id"] = liveDocId;
        const Json::Value liveOpenResult = tool.openResult(liveOpenArgs);
        expect(liveOpenResult.get("text", "").asString().find("livebootstrapalpha") != std::string::npos,
            "Open result did not return the live-bootstrapped page");

        const Json::Value localAfterBootstrap = tool.search(liveSearchArgs);
        expect(localAfterBootstrap["results"].isArray() && !localAfterBootstrap["results"].empty(),
            "Live fallback bootstrap did not populate the local index");
        expect(localAfterBootstrap.get("source", "").asString() != "live_fallback",
            "Search should prefer the local index after bootstrap");

        {
            ScopedDir htmlDir;
            WebSearchTool::Options htmlOptions;
            htmlOptions.storageRoot = htmlDir.path().string();
            htmlOptions.databasePath = (htmlDir.path() / "index.sqlite3").string();
            htmlOptions.enableBackgroundWorker = false;
            htmlOptions.allowPrivateHosts = true;
            htmlOptions.userAgent = "ctrlpanel-websearch-test/1.0";
            htmlOptions.liveSearchBaseUrl = "http://127.0.0.1:" + std::to_string(port) + "/duckduckgo-html-search";
            htmlOptions.liveSearchBootstrapCount = 1;

            WebSearchTool htmlTool(htmlOptions);
            std::string htmlInitError;
            expect(htmlTool.initialize(&htmlInitError), "HTML live search initialization failed: " + htmlInitError);

            Json::Value htmlSearchArgs(Json::objectValue);
            htmlSearchArgs["query"] = "htmlsearchalpha technology";
            htmlSearchArgs["top_k"] = 3;
            const Json::Value htmlSearchResult = htmlTool.search(htmlSearchArgs);
            expect(htmlSearchResult.get("provider", "").asString() == "duckduckgo_html",
                "HTML live search did not report the DuckDuckGo-style provider");
            expect(htmlSearchResult["results"].isArray() && !htmlSearchResult["results"].empty(),
                "HTML live search returned no results");
            expect(htmlSearchResult["results"][0].get("title", "").asString().find("HTML Search Bootstrap Article") != std::string::npos,
                "HTML live search did not parse the result title");
            expect(htmlSearchResult["results"][0].get("doc_id", 0).asInt() > 0,
                "HTML live search did not bootstrap the local index");
        }

        {
            ScopedDir queuedDir;
            WebSearchTool::Options queuedOptions;
            queuedOptions.storageRoot = queuedDir.path().string();
            queuedOptions.databasePath = (queuedDir.path() / "index.sqlite3").string();
            queuedOptions.enableBackgroundWorker = true;
            queuedOptions.allowPrivateHosts = true;
            queuedOptions.userAgent = "ctrlpanel-websearch-test/1.0";
            queuedOptions.liveSearchBaseUrl = "http://127.0.0.1:" + std::to_string(port) + "/search";
            queuedOptions.liveSearchBootstrapCount = 2;

            WebSearchTool queuedTool(queuedOptions);
            std::string queuedInitError;
            expect(queuedTool.initialize(&queuedInitError), "Queued live fallback initialization failed: " + queuedInitError);

            const Json::Value queuedLiveSearchResult = queuedTool.search(liveSearchArgs);
            expect(queuedLiveSearchResult.get("source", "").asString() == "live_fallback",
                "Queued live fallback search did not identify its source");
            expect(queuedLiveSearchResult["results"].isArray() && !queuedLiveSearchResult["results"].empty(),
                "Queued live fallback search returned no results");
            expect(queuedLiveSearchResult["results"][0].get("bootstrap_status", "").asString() == "queued",
                "Queued live fallback should queue indexing instead of blocking inline");
            expect(queuedLiveSearchResult["live_search"].get("bootstrap_mode", "").asString() == "queued",
                "Queued live fallback did not report queued bootstrap mode");
            expect(queuedLiveSearchResult["live_search"].get("queued_results", 0).asInt() >= 1,
                "Queued live fallback did not record queued results");
        }

        {
            ScopedDir cappedDir;
            WebSearchTool::Options cappedOptions;
            cappedOptions.storageRoot = cappedDir.path().string();
            cappedOptions.databasePath = (cappedDir.path() / "index.sqlite3").string();
            cappedOptions.enableBackgroundWorker = false;
            cappedOptions.allowPrivateHosts = true;
            cappedOptions.userAgent = "ctrlpanel-websearch-test/1.0";
            cappedOptions.liveSearchBaseUrl = "http://127.0.0.1:" + std::to_string(port) + "/search";
            cappedOptions.liveSearchBootstrapCount = 1;
            cappedOptions.maxBodyBytes = 2048;
            cappedOptions.httpTimeoutMs = 4000;
            cappedOptions.robotsTimeoutMs = 1000;

            WebSearchTool cappedTool(cappedOptions);
            std::string cappedInitError;
            expect(cappedTool.initialize(&cappedInitError), "Capped web search initialization failed: " + cappedInitError);

            Json::Value largeArgs(Json::objectValue);
            largeArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/large";
            largeArgs["queue_discovered"] = false;
            const Json::Value largeResult = cappedTool.fetchUrl(largeArgs);
            expect(largeResult.get("status", "").asString() == "indexed", "Large page was not indexed");
            expect(largeResult.get("body_truncated", false).asBool(), "Large page was not marked as truncated");
            expect(largeResult["timing_ms"].isObject(), "Large page fetch did not report timing");
            expect(largeResult["robots"].isObject(), "Large page fetch did not report robots diagnostics");
        }

        {
            ScopedDir cancelDir;
            WebSearchTool::Options cancelOptions;
            cancelOptions.storageRoot = cancelDir.path().string();
            cancelOptions.databasePath = (cancelDir.path() / "index.sqlite3").string();
            cancelOptions.enableBackgroundWorker = false;
            cancelOptions.allowPrivateHosts = true;
            cancelOptions.userAgent = "ctrlpanel-websearch-test/1.0";
            cancelOptions.httpTimeoutMs = 15000;
            cancelOptions.robotsTimeoutMs = 1000;

            WebSearchTool cancelTool(cancelOptions);
            std::string cancelInitError;
            expect(cancelTool.initialize(&cancelInitError), "Cancelable web search initialization failed: " + cancelInitError);

            std::atomic<bool> cancelled{false};
            auto started = std::chrono::steady_clock::now();
            auto future = std::async(std::launch::async, [&]() {
                Json::Value slowArgs(Json::objectValue);
                slowArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/slow";
                slowArgs["queue_discovered"] = false;
                return cancelTool.fetchUrl(slowArgs, [&]() { return cancelled.load(); });
            });

            std::this_thread::sleep_for(std::chrono::milliseconds(250));
            cancelled.store(true);
            const Json::Value cancelledResult = future.get();
            const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - started).count();
            expect(cancelledResult.get("status", "").asString() == "cancelled", "Slow fetch was not cancelled");
            expect(cancelledResult.get("error", "").asString() == "Fetch cancelled", "Cancelled fetch returned the wrong error");
            expect(elapsedMs < 5000, "Cancelled fetch took too long to stop");
        }

        {
            ScopedDir timeoutDir;
            WebSearchTool::Options timeoutOptions;
            timeoutOptions.storageRoot = timeoutDir.path().string();
            timeoutOptions.databasePath = (timeoutDir.path() / "index.sqlite3").string();
            timeoutOptions.enableBackgroundWorker = false;
            timeoutOptions.allowPrivateHosts = true;
            timeoutOptions.userAgent = "ctrlpanel-websearch-test/1.0";
            timeoutOptions.httpTimeoutMs = 800;
            timeoutOptions.robotsTimeoutMs = 500;

            WebSearchTool timeoutTool(timeoutOptions);
            std::string timeoutInitError;
            expect(timeoutTool.initialize(&timeoutInitError), "Timeout web search initialization failed: " + timeoutInitError);

            auto started = std::chrono::steady_clock::now();
            Json::Value slowArgs(Json::objectValue);
            slowArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/slow";
            slowArgs["queue_discovered"] = false;
            const Json::Value timeoutResult = timeoutTool.fetchUrl(slowArgs);
            const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - started).count();

            expect(timeoutResult.get("status", "").asString() == "error", "Slow fetch did not return an error");
            expect(timeoutResult.get("timed_out", false).asBool(), "Slow fetch was not marked timed_out");
            expect(elapsedMs < 5000, "Slow fetch ignored the configured timeout");
        }

        sleepForHostDelay();

        Json::Value fetchRootArgs(Json::objectValue);
        fetchRootArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/";
        fetchRootArgs["queue_discovered"] = false;
        const Json::Value rootResult = tool.fetchUrl(fetchRootArgs);
        expect(rootResult.get("status", "").asString() == "indexed", "Root page was not indexed: " + rootResult.toStyledString());
        const int rootDocId = rootResult.get("doc_id", 0).asInt();
        expect(rootDocId > 0, "Root page did not return a doc_id");

        sleepForHostDelay();

        Json::Value articleArgs(Json::objectValue);
        articleArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/article";
        articleArgs["queue_discovered"] = false;
        const Json::Value articleResult = tool.fetchUrl(articleArgs);
        expect(articleResult.get("status", "").asString() == "indexed", "Article page was not indexed: " + articleResult.toStyledString());
        const int articleDocId = articleResult.get("doc_id", 0).asInt();
        expect(articleDocId > 0, "Article page did not return a doc_id");

        Json::Value searchArgs(Json::objectValue);
        searchArgs["query"] = "zebraquantum";
        searchArgs["top_k"] = 5;
        const Json::Value searchResult = tool.search(searchArgs);
        expect(searchResult.isObject(), "Search result must be an object");
        expect(searchResult["results"].isArray() && !searchResult["results"].empty(), "Search did not return any results");
        expect(searchResult["results"][0].get("doc_id", 0).asInt() == articleDocId, "Search did not rank the article first");

        Json::Value openArgs(Json::objectValue);
        openArgs["doc_id"] = articleDocId;
        openArgs["include_links"] = true;
        const Json::Value openResult = tool.openResult(openArgs);
        expect(openResult.get("doc_id", 0).asInt() == articleDocId, "Open result returned the wrong doc_id");
        expect(openResult.get("text", "").asString().find("zebraquantum") != std::string::npos, "Open result text is missing the indexed content");

        Json::Value relatedArgs(Json::objectValue);
        relatedArgs["doc_id"] = rootDocId;
        relatedArgs["strategy"] = "linked";
        const Json::Value relatedResult = tool.relatedResults(relatedArgs);
        expect(relatedResult["results"].isArray() && !relatedResult["results"].empty(), "Related results did not return linked pages");

        sleepForHostDelay();

        Json::Value manyLinksArgs(Json::objectValue);
        manyLinksArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/many-links";
        manyLinksArgs["queue_discovered"] = false;
        const Json::Value manyLinksResult = tool.fetchUrl(manyLinksArgs);
        expect(manyLinksResult.get("status", "").asString() == "indexed", "Many-links page was not indexed");
        expect(manyLinksResult.get("discovered_links", 0).asInt() == 256,
            "Many-links page did not cap discovered links");
        expect(manyLinksResult["timing_ms"].isObject(), "Many-links fetch did not report timing");
        expect(manyLinksResult["robots"].isObject(), "Many-links fetch did not report robots diagnostics");

        sleepForHostDelay();

        Json::Value duplicateArgs(Json::objectValue);
        duplicateArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/duplicate";
        duplicateArgs["queue_discovered"] = false;
        const Json::Value duplicateResult = tool.fetchUrl(duplicateArgs);
        expect(duplicateResult.get("blocked", false).asBool(), "Duplicate page was not marked as blocked");
        expect(duplicateResult.get("duplicate_of", 0).asInt() == articleDocId, "Duplicate page did not point back to the original article");

        sleepForHostDelay();

        Json::Value blockedArgs(Json::objectValue);
        blockedArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/blocked/secret";
        const Json::Value blockedResult = tool.fetchUrl(blockedArgs);
        expect(blockedResult.get("status", "").asString() == "blocked", "Robots-disallowed page was not blocked");

        sleepForHostDelay();

        Json::Value sitemapArgs(Json::objectValue);
        sitemapArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/sitemap.xml";
        const Json::Value sitemapResult = tool.fetchUrl(sitemapArgs);
        expect(sitemapResult.get("status", "").asString() == "sitemap_processed", "Sitemap was not processed");
        expect(sitemapResult.get("queued", 0).asInt() >= 2, "Sitemap did not queue discovered URLs");

        sleepForHostDelay();

        Json::Value etagArgs(Json::objectValue);
        etagArgs["url"] = "http://127.0.0.1:" + std::to_string(port) + "/etag";
        etagArgs["queue_discovered"] = false;
        const Json::Value firstEtag = tool.fetchUrl(etagArgs);
        expect(firstEtag.get("status", "").asString() == "indexed", "ETag page was not indexed on first fetch");

        sleepForHostDelay();

        const Json::Value secondEtag = tool.fetchUrl(etagArgs);
        expect(secondEtag.get("status", "").asString() == "not_modified", "Conditional revalidation did not return not_modified");
        expect(etagFetchCount == 1, "ETag endpoint should have been fully fetched exactly once");

        const Json::Value status = tool.status();
        expect(status["documents"].get("total", 0).asInt() >= 3, "Status did not record indexed documents");
        expect(status["documents"].get("duplicates", 0).asInt() >= 1, "Status did not record duplicates");
        expect(status["queue"].get("pending", 0).asInt() >= 2, "Status did not record queued sitemap URLs");

        const Json::Value health = tool.health();
        expect(health.get("available", false).asBool(), "Health did not report the web search tool as available");
        expect(health.get("initialized", false).asBool(), "Health did not report the web search tool as initialized");
        expect(health.get("live_search_enabled", false).asBool(), "Health did not report live search fallback as enabled");

        return 0;
    } catch (const std::exception& exception) {
        std::cerr << "web_search_tool_test failed: " << exception.what() << "\n";
        return 1;
    }
}
