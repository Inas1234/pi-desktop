use serde_json::{Map, Value, json};

const MAX_TEXT_BYTES: usize = 48 * 1024;
const MAX_DETAILS_BYTES: usize = 64 * 1024;
const MAX_DEPTH: usize = 8;
const MAX_COLLECTION_ITEMS: usize = 128;
const MAX_STRING_BYTES: usize = 8 * 1024;
const MAX_KEY_BYTES: usize = 512;
const TRUNCATED_TEXT: &str = "… output truncated …\n";

pub fn project_event(value: &mut Value) {
    match value.get("type").and_then(Value::as_str) {
        Some("tool_execution_start" | "tool_execution_update" | "tool_execution_end") => {
            project_field(value, "args", "argsTruncated");
            let payload_key = if value.get("partialResult").is_some() {
                "partialResult"
            } else {
                "result"
            };
            if let Some(payload) = value.get_mut(payload_key) {
                project_tool_payload(payload);
            }
        }
        Some("message_start" | "message_end") => {
            if let Some(message) = value.get_mut("message") {
                project_message(message);
            }
        }
        Some("extension_ui_request") => project_extension_request(value),
        Some("extension_error") => {
            for key in ["extensionPath", "event"] {
                if let Some(text) = value.get(key).and_then(Value::as_str).map(str::to_owned) {
                    value[key] = Value::String(truncate_start(&text, MAX_STRING_BYTES).0);
                }
            }
            if let Some(error) = value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                value["error"] = Value::String(truncate_tail(&error, MAX_TEXT_BYTES).0);
            }
        }
        _ => {}
    }
}

pub fn project_message(message: &mut Value) {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if matches!(role.as_str(), "toolResult" | "custom") {
        if let Some(content) = message.get_mut("content") {
            bound_text_content(content);
        }
        project_field(message, "details", "detailsTruncated");
    }
    if role == "assistant"
        && let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut)
    {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) == Some("toolCall") {
                project_field(block, "arguments", "argumentsTruncated");
            }
        }
    }
}

fn project_tool_payload(payload: &mut Value) {
    if payload.is_string() {
        bound_text_content(payload);
        return;
    }
    if payload.is_array() {
        if extract_text(payload).is_empty() {
            let (details, truncated) = bounded_json(std::mem::take(payload));
            *payload = json!({
                "details": details,
                "detailsTruncated": truncated,
            });
        } else {
            bound_text_content(payload);
        }
        return;
    }
    if let Some(object) = payload.as_object_mut() {
        let mut content = object.remove("content");
        let had_details = object.contains_key("details");
        if let Some(content) = content.as_mut() {
            bound_text_content(content);
        }
        let (bounded, truncated) = bounded_json(Value::Object(std::mem::take(object)));
        if let Value::Object(mut bounded) = bounded {
            if let Some(content) = content {
                bounded.insert("content".into(), content);
            }
            if truncated {
                bounded.insert("detailsTruncated".into(), Value::Bool(true));
            }
            if had_details && !bounded.contains_key("details") {
                bounded.insert("details".into(), json!({ "__piDesktopTruncated": true }));
            }
            *payload = Value::Object(bounded);
        }
    } else {
        let (details, truncated) = bounded_json(std::mem::take(payload));
        *payload = json!({
            "details": details,
            "detailsTruncated": truncated,
        });
    }
}

fn project_extension_request(value: &mut Value) {
    for key in ["title", "message", "placeholder", "prefill", "text"] {
        if let Some(text) = value.get(key).and_then(Value::as_str).map(str::to_owned) {
            value[key] = Value::String(truncate_start(&text, MAX_STRING_BYTES).0);
        }
    }
    for key in ["options", "widgetLines"] {
        if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
            items.truncate(MAX_COLLECTION_ITEMS);
            for item in items {
                if let Some(text) = item.as_str() {
                    *item = Value::String(truncate_start(text, MAX_STRING_BYTES).0);
                }
            }
        }
    }
}

fn project_field(parent: &mut Value, field: &str, marker: &str) {
    let Some(object) = parent.as_object_mut() else {
        return;
    };
    let Some(value) = object.remove(field) else {
        return;
    };
    let (projected, truncated) = bounded_json(value);
    object.insert(field.to_owned(), projected);
    if truncated {
        object.insert(marker.to_owned(), Value::Bool(true));
    }
}

fn bounded_json(value: Value) -> (Value, bool) {
    let mut budget = MAX_DETAILS_BYTES;
    let mut truncated = false;
    let projected = project_json(value, 0, &mut budget, &mut truncated);
    if serde_json::to_vec(&projected).is_ok_and(|bytes| bytes.len() <= MAX_DETAILS_BYTES) {
        (projected, truncated)
    } else {
        (json!({ "__piDesktopTruncated": true }), true)
    }
}

fn project_json(value: Value, depth: usize, budget: &mut usize, truncated: &mut bool) -> Value {
    if depth >= MAX_DEPTH || *budget < 8 {
        *truncated = true;
        return json!({ "__piDesktopTruncated": true });
    }
    match value {
        Value::Null => {
            *budget = budget.saturating_sub(4);
            Value::Null
        }
        Value::Bool(value) => {
            *budget = budget.saturating_sub(5);
            Value::Bool(value)
        }
        Value::Number(value) => {
            *budget = budget.saturating_sub(value.to_string().len());
            Value::Number(value)
        }
        Value::String(value) => {
            let allowed = MAX_STRING_BYTES.min(budget.saturating_sub(2));
            let (value, was_truncated) = truncate_start(&value, allowed);
            if was_truncated {
                *truncated = true;
            }
            *budget = budget.saturating_sub(value.len() + 2);
            Value::String(value)
        }
        Value::Array(values) => {
            let collection_truncated = values.len() > MAX_COLLECTION_ITEMS;
            let mut result = Vec::new();
            *budget = budget.saturating_sub(2);
            for value in values.into_iter().take(MAX_COLLECTION_ITEMS) {
                if *budget < 16 {
                    *truncated = true;
                    break;
                }
                result.push(project_json(value, depth + 1, budget, truncated));
                *budget = budget.saturating_sub(1);
            }
            if collection_truncated {
                *truncated = true;
            }
            Value::Array(result)
        }
        Value::Object(values) => {
            let collection_truncated = values.len() > MAX_COLLECTION_ITEMS;
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by_key(|(_, value)| {
                !value.is_null() && !value.is_boolean() && !value.is_number() && !value.is_string()
            });
            let mut result = Map::new();
            *budget = budget.saturating_sub(2);
            for (key, value) in entries.into_iter().take(MAX_COLLECTION_ITEMS) {
                let (key, key_truncated) = truncate_start(&key, MAX_KEY_BYTES);
                *truncated |= key_truncated;
                if *budget < key.len() + 16 {
                    *truncated = true;
                    break;
                }
                *budget = budget.saturating_sub(key.len() + 3);
                result.insert(key, project_json(value, depth + 1, budget, truncated));
            }
            if collection_truncated {
                *truncated = true;
            }
            Value::Object(result)
        }
    }
}

fn bound_text_content(content: &mut Value) {
    let text = extract_text(content);
    let (text, _) = truncate_tail(&text, MAX_TEXT_BYTES);
    *content = Value::Array(vec![json!({ "type": "text", "text": text })]);
}

fn extract_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .or_else(|| block.as_str())
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn truncate_tail(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }
    let available = max_bytes.saturating_sub(TRUNCATED_TEXT.len());
    let mut start = value.len().saturating_sub(available);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    (format!("{TRUNCATED_TEXT}{}", &value[start..]), true)
}

fn truncate_start(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }
    let mut end = max_bytes.saturating_sub('…'.len_utf8());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &value[..end]), true)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{MAX_DETAILS_BYTES, project_event, project_message};

    #[test]
    fn bounds_tool_text_and_structured_details() {
        let mut event = json!({
            "type": "tool_execution_end",
            "toolCallId": "one",
            "toolName": "custom",
            "result": {
                "content": [{"type": "text", "text": "x".repeat(80_000)}],
                "details": {"rows": (0..500).map(|index| json!({"index": index, "value": "y".repeat(1000)})).collect::<Vec<_>>()}
            }
        });
        project_event(&mut event);
        assert!(
            event
                .pointer("/result/detailsTruncated")
                .and_then(|value| value.as_bool())
                .unwrap()
        );
        assert!(
            serde_json::to_vec(event.pointer("/result/details").unwrap())
                .unwrap()
                .len()
                <= MAX_DETAILS_BYTES
        );
        assert!(
            event
                .pointer("/result/content/0/text")
                .unwrap()
                .as_str()
                .unwrap()
                .len()
                < 50_000
        );
    }

    #[test]
    fn projects_custom_message_details() {
        let mut message = json!({
            "role": "custom",
            "customType": "example",
            "display": true,
            "content": "hello",
            "details": {"deep": [[[[[[[[["hidden"]]]]]]]]]}
        });
        project_message(&mut message);
        assert_eq!(
            message
                .pointer("/content/0/text")
                .and_then(|value| value.as_str()),
            Some("hello")
        );
        assert_eq!(
            message
                .get("detailsTruncated")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn bounds_unknown_tool_fields_and_extension_errors_before_ipc() {
        let mut tool = json!({
            "type": "tool_execution_update",
            "partialResult": {
                "content": [{"type": "text", "text": "working"}],
                "futurePayload": "x".repeat(100_000)
            }
        });
        project_event(&mut tool);
        assert!(
            serde_json::to_vec(tool.get("partialResult").unwrap())
                .unwrap()
                .len()
                < 70_000
        );
        assert_eq!(
            tool.pointer("/partialResult/detailsTruncated")
                .and_then(Value::as_bool),
            Some(true)
        );

        let mut error = json!({
            "type": "extension_error",
            "extensionPath": "p".repeat(20_000),
            "event": "tool_call",
            "error": "e".repeat(100_000)
        });
        project_event(&mut error);
        assert!(error["extensionPath"].as_str().unwrap().len() < 9_000);
        assert!(error["error"].as_str().unwrap().len() < 50_000);
    }
}
