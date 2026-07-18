use std::time::Duration;

use dom_query::Document;
use reqwest::{Client, header};

use crate::{
    error::{AppError, AppResult},
    models::{PackageCatalogItem, PackageCatalogPage, PackageCatalogQuery},
};

const CATALOG_URL: &str = "https://pi.dev/packages";
const CATALOG_PAGE_SIZE: usize = 50;
const MAX_CATALOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_CATALOG_PAGE: usize = 1_000;
const MAX_QUERY_BYTES: usize = 200;

pub struct PackageCatalog {
    client: Option<Client>,
}

impl PackageCatalog {
    pub fn new() -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 3 {
                    return attempt.error("too many Pi catalog redirects");
                }
                let next = attempt.url();
                if next.scheme() == "https" && next.host_str() == Some("pi.dev") {
                    attempt.follow()
                } else {
                    attempt.error("Pi catalog redirect left the allowed origin")
                }
            }))
            .user_agent("Pi-Desktop/0.1 package-catalog")
            .build()
            .ok();
        Self { client }
    }

    pub async fn browse(&self, query: PackageCatalogQuery) -> AppResult<PackageCatalogPage> {
        let query = ValidatedQuery::try_from(query)?;
        let client = self.client.as_ref().ok_or_else(|| {
            AppError::Message("The package catalog HTTP client could not be initialized".into())
        })?;
        let mut parameters = vec![
            ("sort", query.sort.clone()),
            ("page", query.page.to_string()),
        ];
        if !query.name.is_empty() {
            parameters.push(("name", query.name.clone()));
        }
        if !query.package_type.is_empty() {
            parameters.push(("type", query.package_type.clone()));
        }

        let mut response = client
            .get(CATALOG_URL)
            .query(&parameters)
            .header(header::ACCEPT, "text/html")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|error| catalog_error("could not be reached", &error))?;
        if !response.status().is_success() {
            return Err(AppError::Message(format!(
                "The Pi package catalog returned HTTP {}. Try again later or open pi.dev/packages.",
                response.status().as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|length| length > u64::try_from(MAX_CATALOG_BYTES).unwrap_or(u64::MAX))
        {
            return Err(AppError::Message(
                "The Pi package catalog response exceeded the 2 MiB safety limit".into(),
            ));
        }
        if !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/html"))
        {
            return Err(AppError::Message(
                "The Pi package catalog returned an unsupported response format".into(),
            ));
        }

        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| catalog_error("response was interrupted", &error))?
        {
            if body.len().saturating_add(chunk.len()) > MAX_CATALOG_BYTES {
                return Err(AppError::Message(
                    "The Pi package catalog response exceeded the 2 MiB safety limit".into(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let html = String::from_utf8(body).map_err(|_| {
            AppError::Message("The Pi package catalog returned invalid UTF-8".into())
        })?;
        parse_catalog_page(&html, query.page)
    }
}

struct ValidatedQuery {
    name: String,
    package_type: String,
    sort: String,
    page: usize,
}

impl TryFrom<PackageCatalogQuery> for ValidatedQuery {
    type Error = AppError;

    fn try_from(value: PackageCatalogQuery) -> Result<Self, Self::Error> {
        let name = value.name.unwrap_or_default().trim().to_owned();
        if name.len() > MAX_QUERY_BYTES || name.chars().any(char::is_control) {
            return Err(AppError::Message(
                "Package catalog searches must be 200 characters or fewer and contain no control characters"
                    .into(),
            ));
        }
        let package_type = value.package_type.unwrap_or_default();
        if !matches!(
            package_type.as_str(),
            "" | "extension" | "skill" | "theme" | "prompt"
        ) {
            return Err(AppError::Message(
                "Unsupported package catalog type filter".into(),
            ));
        }
        let sort = value.sort.unwrap_or_else(|| "downloads".into());
        if !matches!(sort.as_str(), "downloads" | "recent" | "name") {
            return Err(AppError::Message(
                "Unsupported package catalog sort order".into(),
            ));
        }
        let page = value.page.unwrap_or(1);
        if !(1..=MAX_CATALOG_PAGE).contains(&page) {
            return Err(AppError::Message(
                "Package catalog page is outside the supported range".into(),
            ));
        }
        Ok(Self {
            name,
            package_type,
            sort,
            page,
        })
    }
}

fn catalog_error(context: &str, error: &reqwest::Error) -> AppError {
    let detail = if error.is_timeout() {
        "the request timed out"
    } else if error.is_connect() {
        "check the network connection"
    } else {
        "try again later"
    };
    AppError::Message(format!(
        "The Pi package catalog {context}; {detail}, or open pi.dev/packages in a browser."
    ))
}

fn parse_catalog_page(html: &str, page: usize) -> AppResult<PackageCatalogPage> {
    let document = Document::from(html);
    let count = document.select(".packages-count").text().trim().to_owned();
    if count.is_empty() {
        return Err(compatibility_error());
    }
    let total = parse_catalog_total(&count).ok_or_else(compatibility_error)?;
    let mut items = Vec::new();
    for card in document.select("[data-package-card]").iter() {
        if items.len() >= CATALOG_PAGE_SIZE {
            break;
        }
        let Some(name) = card
            .attr("data-package-name")
            .map(|value| value.to_string())
        else {
            continue;
        };
        if !valid_package_name(&name) {
            continue;
        }
        let metadata = card
            .select(".packages-meta span")
            .iter()
            .map(|entry| entry.text().trim().to_owned())
            .collect::<Vec<_>>();
        let author = metadata.first().cloned().unwrap_or_default();
        let published = metadata.get(2).cloned().unwrap_or_default();
        let downloads = card
            .attr("data-package-downloads")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or_default();
        let types = card
            .attr("data-package-types")
            .map(|value| {
                value
                    .split_whitespace()
                    .take(8)
                    .map(|entry| bounded_text(entry, 32))
                    .collect()
            })
            .unwrap_or_default();
        let repository_url = card
            .select(".packages-links a")
            .iter()
            .filter_map(|entry| entry.attr("href"))
            .map(|value| value.to_string())
            .find(|value| {
                value.starts_with("https://github.com/") || value.starts_with("https://gitlab.com/")
            });
        items.push(PackageCatalogItem {
            npm_url: format!("https://www.npmjs.com/package/{name}"),
            detail_url: format!("https://pi.dev/packages/{name}"),
            name,
            description: bounded_text(card.select(".packages-desc").text().trim(), 2_000),
            author: bounded_text(&author, 256),
            downloads,
            published: bounded_text(&published, 64),
            types,
            repository_url,
        });
    }
    if total > 0 && items.is_empty() {
        return Err(compatibility_error());
    }
    let page_count = total.div_ceil(CATALOG_PAGE_SIZE);
    let from = if items.is_empty() {
        0
    } else {
        (page - 1)
            .saturating_mul(CATALOG_PAGE_SIZE)
            .saturating_add(1)
    };
    let to = if items.is_empty() {
        0
    } else {
        from.saturating_add(items.len() - 1)
    };
    Ok(PackageCatalogPage {
        items,
        page,
        page_count,
        total,
        from,
        to,
    })
}

fn parse_catalog_total(value: &str) -> Option<usize> {
    let before_slash = value.split('/').next()?.trim();
    if before_slash == "0" {
        return Some(0);
    }
    let after_slash = value.split_once('/')?.1.split("(of").next()?.trim();
    let digits = after_slash
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
}

fn valid_package_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 214
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "@/._-".contains(character))
}

fn bounded_text(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut boundary = limit;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}…", &value[..boundary])
}

fn compatibility_error() -> AppError {
    AppError::Message(
        "The Pi package catalog format is not compatible with this Pi Desktop build. Open pi.dev/packages in a browser and update Pi Desktop when a newer version is available."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_catalog_cards_and_filtered_counts() {
        let html = r#"
          <span class="packages-count">1-2 / 2 (of 5300)</span>
          <article data-package-card="true" data-package-name="@scope/agents" data-package-downloads="1234" data-package-types="extension skill">
            <p class="packages-desc">Agent helpers &amp; tools</p>
            <div class="packages-meta"><span>alice</span><span>1,234/mo</span><span>2d ago</span></div>
            <div class="packages-links"><a href="https://www.npmjs.com/package/@scope/agents">npm</a><a href="https://github.com/alice/agents">repo</a></div>
          </article>
          <article data-package-card="true" data-package-name="pi-theme" data-package-downloads="40" data-package-types="theme">
            <p class="packages-desc">A restrained theme</p>
            <div class="packages-meta"><span>bob</span><span>40/mo</span><span>1mo ago</span></div>
          </article>
        "#;
        let page = parse_catalog_page(html, 1).expect("fixture should parse");
        assert_eq!(page.total, 2);
        assert_eq!(page.page_count, 1);
        assert_eq!(page.from, 1);
        assert_eq!(page.to, 2);
        assert_eq!(page.items[0].name, "@scope/agents");
        assert_eq!(page.items[0].description, "Agent helpers & tools");
        assert_eq!(page.items[0].types, ["extension", "skill"]);
        assert_eq!(
            page.items[0].repository_url.as_deref(),
            Some("https://github.com/alice/agents")
        );
    }

    #[test]
    fn accepts_empty_results_but_rejects_unknown_markup() {
        let empty = parse_catalog_page(
            r#"<span class="packages-count">0 / 5300</span><p>No matches</p>"#,
            1,
        )
        .expect("empty search is valid");
        assert!(empty.items.is_empty());
        assert_eq!(empty.total, 0);
        assert!(parse_catalog_page("<html>changed</html>", 1).is_err());
    }

    #[test]
    fn validates_catalog_queries() {
        let invalid_type = PackageCatalogQuery {
            name: None,
            package_type: Some("bundle".into()),
            sort: None,
            page: None,
        };
        assert!(ValidatedQuery::try_from(invalid_type).is_err());
        let invalid_name = PackageCatalogQuery {
            name: Some("bad\nquery".into()),
            package_type: None,
            sort: None,
            page: None,
        };
        assert!(ValidatedQuery::try_from(invalid_name).is_err());
    }
}
