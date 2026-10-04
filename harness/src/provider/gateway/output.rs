//! Gateway grammar stays small; the host's canonical canvas contract remains authoritative.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::HashSet;

pub struct CanvasOutput {
    pub schema: Value,
    operations: HashSet<String>,
}

impl CanvasOutput {
    pub fn from_schema(original: &Value) -> Option<Self> {
        let properties = original["properties"].as_object()?;
        if properties.get("reply")?["type"] != "string"
            || properties.get("operations")?["type"] != "array"
        {
            return None;
        }
        let operations = &properties["operations"];
        let names = operations["items"]["properties"]["op"]["enum"].as_array();
        let empty = operations["maxItems"] == 0;
        if names.is_none() && !empty {
            return None;
        }
        let allowed = if empty {
            vec![]
        } else {
            names?
                .iter()
                .map(|name| name.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?
        };
        let mut op = json!({"type":"string"});
        if !allowed.is_empty() {
            op["enum"] = json!(allowed);
        }
        let mut arguments = operations["items"].clone();
        if let Some(properties) = arguments["properties"].as_object_mut() {
            properties.remove("op");
        }
        if let Some(object) = arguments.as_object_mut() {
            object.remove("required");
        }
        let item = json!({
            "type":"object", "additionalProperties":false,
            "properties":{
                "op":op,
                "arguments_json":{"type":"string","description":format!(
                    "A JSON object encoding every field of the canvas operation except op. Omit unused fields or set them to null. Argument definitions: {}",
                    arguments
                )}
            }, "required":["op","arguments_json"]
        });
        let schema = json!({
            "type":"object", "additionalProperties":false,
            "description":"Use the FlowM canvas envelope. Each operation contains op and arguments_json, a JSON object encoded as a string. Do not execute canvas operations as project tools.",
            "properties":{
                "reply":properties["reply"].clone(),
                "question":nullable_schema(properties.get("question")?),
                "operations":{"type":"array","items":item,"description":if empty {
                    "This phase permits no canvas operations. Return []."
                } else { "Return operations in order; use [] for an answer or question without operations." }}
            }, "required":["reply","question","operations"]
        });
        Some(Self {
            schema,
            operations: allowed.into_iter().collect(),
        })
    }

    pub fn decode(&self, text: &str) -> Result<String> {
        let mut envelope: Value = serde_json::from_str(text)
            .context("Gateway returned invalid canvas JSON; no canvas operation was applied")?;
        let operations = envelope["operations"]
            .as_array_mut()
            .context("Gateway omitted canvas operations")?;
        for operation in operations {
            let name = operation["op"]
                .as_str()
                .context("Gateway omitted a canvas operation name")?
                .to_owned();
            if !self.operations.contains(&name) {
                bail!("Gateway returned a canvas operation forbidden in this phase: {name}");
            }
            let encoded = operation["arguments_json"]
                .as_str()
                .context("Gateway omitted JSON-encoded canvas arguments")?;
            let decoded: Value = serde_json::from_str(encoded).context(
                "Gateway returned invalid canvas arguments; no canvas operation was applied",
            )?;
            let mut arguments = decoded
                .as_object()
                .context("Gateway canvas arguments must be an object")?
                .clone();
            if arguments.contains_key("op") {
                bail!("Gateway canvas arguments must not override the operation name");
            }
            arguments.insert("op".into(), Value::String(name));
            *operation = Value::Object(arguments);
        }
        Ok(serde_json::to_string(&envelope)?)
    }
}

fn nullable_schema(schema: &Value) -> Value {
    let mut result = schema.clone();
    if let Some(types) = schema["type"].as_array() {
        if types.len() == 2 && types.iter().any(|value| value == "null") {
            let other = types.iter().find(|value| *value != "null").unwrap();
            result["type"] = other.clone();
            if let Some(values) = result.get_mut("enum").and_then(Value::as_array_mut) {
                values.retain(|value| !value.is_null());
            }
            return json!({"anyOf":[result,{"type":"null"}]});
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn original() -> Value {
        json!({"type":"object","properties":{
            "reply":{"type":"string"},"question":{"type":["object","null"],"properties":{"prompt":{"type":"string"}},"required":["prompt"],"additionalProperties":false},
            "operations":{"type":"array","items":{"type":"object","properties":{
                "op":{"type":"string","enum":["declare_diagram","create_geo"]},
                "kind":{"type":["string","null"],"enum":["process","structure",null]},
                "shape":{"type":["string","null"],"enum":["rectangle","ellipse",null]}
            }}}
        }})
    }
    #[test]
    fn nullable_question_does_not_insert_null_schema_keywords() {
        let codec = CanvasOutput::from_schema(&original()).unwrap();
        let question = &codec.schema["properties"]["question"]["anyOf"][0];
        assert!(
            question.get("enum").is_none(),
            "an absent enum must not become enum: null"
        );
        assert_eq!(question["required"], json!(["prompt"]));
        assert!(question["properties"].is_object());
        let mut source = original();
        source["properties"]["question"] =
            json!({"type":["string","null"],"enum":["yes","no",null]});
        let codec = CanvasOutput::from_schema(&source).unwrap();
        assert_eq!(
            codec.schema["properties"]["question"]["anyOf"][0]["enum"],
            json!(["yes", "no"])
        );
    }

    #[test]
    fn nullable_enums_are_outside_the_gateway_grammar_and_canonical_operations_are_restored() {
        let source = original();
        let codec = CanvasOutput::from_schema(&source).unwrap();
        assert_eq!(
            codec.schema["properties"]["operations"]["items"]["properties"]["op"]["type"],
            "string"
        );
        assert!(codec.schema["properties"]["question"]["anyOf"].is_array());
        let result = codec.decode(&json!({"reply":"Done","question":null,"operations":[
            {"op":"declare_diagram","arguments_json":"{\"kind\":\"process\",\"regions\":[{\"kind\":\"process\"}]}"},
            {"op":"create_geo","arguments_json":"{\"shape\":\"rectangle\",\"x\":null}"}
        ]}).to_string()).unwrap();
        let value: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["operations"][0]["kind"], "process");
        assert_eq!(value["operations"][0]["regions"][0]["kind"], "process");
        assert_eq!(value["operations"][1]["shape"], "rectangle");
        assert!(value["operations"][1]["x"].is_null());
        assert_eq!(source, original());
    }
    #[test]
    fn malformed_arguments_and_operation_overrides_fail_before_host_execution() {
        let codec = CanvasOutput::from_schema(&original()).unwrap();
        for operation in [
            json!({"op":"create_geo","arguments_json":"not json"}),
            json!({"op":"create_geo","arguments_json":"[]"}),
            json!({"op":"create_geo","arguments_json":"{\"op\":\"delete_shape\"}"}),
            json!({"op":"delete_shape","arguments_json":"{}"}),
        ] {
            assert!(
                codec
                    .decode(
                        &json!({"reply":"","question":null,"operations":[operation]}).to_string()
                    )
                    .is_err()
            );
        }
    }
    #[test]
    fn finalize_rejects_operations_without_using_unsupported_array_constraints() {
        let mut source = original();
        source["properties"]["operations"]["maxItems"] = json!(0);
        let codec = CanvasOutput::from_schema(&source).unwrap();
        assert!(
            codec.schema["properties"]["operations"]
                .get("maxItems")
                .is_none()
        );
        assert!(
            codec
                .decode(r#"{"reply":"Final","question":null,"operations":[]}"#)
                .is_ok()
        );
        assert!(codec.decode(r#"{"reply":"","question":null,"operations":[{"op":"create_geo","arguments_json":"{}"}]}"#).is_err());
        assert!(
            CanvasOutput::from_schema(
                &json!({"type":"object","properties":{"answer":{"type":"string"}}})
            )
            .is_none()
        );
    }
}
