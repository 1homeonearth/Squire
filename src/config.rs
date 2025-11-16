use std::collections::HashMap;
use std::env;
use std::fmt::{self, Display};
use std::fs;
use std::path::PathBuf;

/// Minimal configuration model for the self-contained Rust rewrite.
///
/// All values are stored as plain strings or booleans and read from a JSON file
/// that avoids external parsing crates. Environment placeholders of the form
/// `$ENV{VAR_NAME}` are expanded after parsing so secrets never live on disk.
#[derive(Debug, Clone)]
pub struct Config {
    pub discord_token: String,
    pub application_id: String,
    pub public_key: String,
    pub database_path: String,
    pub feature_flags: HashMap<String, bool>,
}

/// Errors produced while loading configuration.
#[derive(Debug)]
pub enum ConfigError {
    Missing(PathBuf),
    Read(PathBuf, std::io::Error),
    Parse(String),
    MissingEnvVar(String),
    InvalidShape(String),
}

impl Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Missing(path) => write!(f, "config file not found at {}", path.display()),
            ConfigError::Read(path, err) => {
                write!(f, "unable to read config at {}: {}", path.display(), err)
            }
            ConfigError::Parse(msg) => write!(f, "unable to parse config JSON: {}", msg),
            ConfigError::MissingEnvVar(name) => {
                write!(f, "environment variable {} is required but missing", name)
            }
            ConfigError::InvalidShape(msg) => write!(f, "invalid config structure: {}", msg),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Simplified JSON representation that covers the shapes needed for the config
/// file. This intentionally ignores numbers, nulls, and arrays to keep parsing
/// narrow and auditable.
#[derive(Debug, Clone)]
enum JsonValue {
    Object(HashMap<String, JsonValue>),
    String(String),
    Bool(bool),
}

/// Minimal JSON parser. It accepts objects with string keys and string or
/// boolean values, matching the repo's configuration needs. The parser is
/// purposefully strict: any unknown literal or structure results in a clear
/// error so configuration mistakes surface immediately.
struct JsonParser<'a> {
    input: &'a [u8],
    index: usize,
}

impl<'a> JsonParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            input: text.as_bytes(),
            index: 0,
        }
    }

    fn parse_value(&mut self) -> Result<JsonValue, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_object(),
            Some(b'"') => self.parse_string().map(JsonValue::String),
            Some(b't') | Some(b'f') => self.parse_bool().map(JsonValue::Bool),
            Some(other) => Err(format!(
                "unexpected character '{}' while parsing value",
                other as char
            )),
            None => Err("unexpected end of input".to_string()),
        }
    }

    fn parse_object(&mut self) -> Result<JsonValue, String> {
        self.expect(b'{')?;
        self.skip_ws();
        let mut map = HashMap::new();

        if self.peek() == Some(b'}') {
            self.index += 1;
            return Ok(JsonValue::Object(map));
        }

        loop {
            self.skip_ws();
            let key = match self.parse_string() {
                Ok(text) => text,
                Err(err) => return Err(format!("invalid object key: {}", err)),
            };

            self.skip_ws();
            self.expect(b':')?;
            let value = self.parse_value()?;
            map.insert(key, value);

            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.index += 1;
                    continue;
                }
                Some(b'}') => {
                    self.index += 1;
                    break;
                }
                Some(other) => {
                    return Err(format!(
                        "unexpected character '{}' inside object",
                        other as char
                    ));
                }
                None => return Err("unexpected end of input inside object".to_string()),
            }
        }

        Ok(JsonValue::Object(map))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        while let Some(ch) = self.peek() {
            self.index += 1;
            match ch {
                b'"' => return Ok(out),
                b'\\' => {
                    let escaped = self.peek().ok_or_else(|| "incomplete escape".to_string())?;
                    self.index += 1;
                    let translated = match escaped {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{0008}',
                        b'f' => '\u{000C}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        other => {
                            return Err(format!("unsupported escape sequence: {}", other as char));
                        }
                    };
                    out.push(translated);
                }
                _ => out.push(ch as char),
            }
        }

        Err("unterminated string".to_string())
    }

    fn parse_bool(&mut self) -> Result<bool, String> {
        if self.starts_with(b"true") {
            self.index += 4;
            Ok(true)
        } else if self.starts_with(b"false") {
            self.index += 5;
            Ok(false)
        } else {
            Err("invalid boolean literal".to_string())
        }
    }

    fn starts_with(&self, text: &[u8]) -> bool {
        self.input.len() >= self.index + text.len()
            && &self.input[self.index..self.index + text.len()] == text
    }

    fn expect(&mut self, expected: u8) -> Result<(), String> {
        if self.peek() == Some(expected) {
            self.index += 1;
            Ok(())
        } else {
            Err(format!(
                "expected '{}' but found '{}'",
                expected as char,
                self.peek().map(|b| b as char).unwrap_or('\0')
            ))
        }
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.index += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.index).copied()
    }
}

impl Config {
    /// Load and parse configuration from disk, expanding `$ENV{...}` placeholders
    /// after parsing so secrets can remain outside the repository.
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, ConfigError> {
        let path = path.into();
        if !path.exists() {
            return Err(ConfigError::Missing(path));
        }

        let raw = fs::read_to_string(&path).map_err(|err| ConfigError::Read(path.clone(), err))?;
        let mut parser = JsonParser::new(&raw);
        let mut value = parser.parse_value().map_err(ConfigError::Parse)?;
        parser.skip_ws();
        if parser.peek().is_some() {
            return Err(ConfigError::Parse(
                "trailing characters after JSON document".into(),
            ));
        }

        resolve_env_placeholders(&mut value)?;
        let root = match value {
            JsonValue::Object(map) => map,
            _ => {
                return Err(ConfigError::InvalidShape(
                    "top-level JSON must be an object".into(),
                ));
            }
        };

        let discord_token = take_string(&root, "discord_token")?;
        let application_id = take_string(&root, "application_id")?;
        let public_key = take_string(&root, "public_key")?;
        let database_path = take_string(&root, "database_path")?;
        let feature_flags = take_feature_flags(&root)?;

        Ok(Config {
            discord_token,
            application_id,
            public_key,
            database_path,
            feature_flags,
        })
    }
}

fn resolve_env_placeholders(value: &mut JsonValue) -> Result<(), ConfigError> {
    match value {
        JsonValue::String(text) => {
            if let Some(var) = extract_env_placeholder(text) {
                let replacement =
                    env::var(&var).map_err(|_| ConfigError::MissingEnvVar(var.clone()))?;
                *text = replacement;
            }
        }
        JsonValue::Bool(_) => {}
        JsonValue::Object(map) => {
            for val in map.values_mut() {
                resolve_env_placeholders(val)?;
            }
        }
    }
    Ok(())
}

fn extract_env_placeholder(text: &str) -> Option<String> {
    if text.starts_with("$ENV{") && text.ends_with('}') {
        let inner = &text[5..text.len() - 1];
        if !inner.is_empty() {
            return Some(inner.to_string());
        }
    }
    None
}

fn take_string(map: &HashMap<String, JsonValue>, key: &str) -> Result<String, ConfigError> {
    match map.get(key) {
        Some(JsonValue::String(text)) => Ok(text.clone()),
        Some(_) => Err(ConfigError::InvalidShape(format!(
            "field '{}' must be a string",
            key
        ))),
        None => Err(ConfigError::InvalidShape(format!(
            "missing required field '{}'",
            key
        ))),
    }
}

fn take_feature_flags(
    map: &HashMap<String, JsonValue>,
) -> Result<HashMap<String, bool>, ConfigError> {
    match map.get("feature_flags") {
        None => Ok(HashMap::new()),
        Some(JsonValue::Object(items)) => {
            let mut flags = HashMap::new();
            for (key, value) in items.iter() {
                match value {
                    JsonValue::Bool(enabled) => {
                        flags.insert(key.clone(), *enabled);
                    }
                    _ => {
                        return Err(ConfigError::InvalidShape(format!(
                            "feature flag '{}' must be boolean",
                            key
                        )));
                    }
                }
            }
            Ok(flags)
        }
        Some(_) => Err(ConfigError::InvalidShape(
            "feature_flags must be an object of booleans".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_config() {
        let text = r#"{
            "discord_token": "abc",
            "application_id": "123",
            "public_key": "xyz",
            "database_path": "data.db",
            "feature_flags": { "xp": true, "mod": false }
        }"#;

        let mut parser = JsonParser::new(text);
        let value = parser.parse_value().expect("parse");
        assert!(matches!(value, JsonValue::Object(_)));
    }

    #[test]
    fn expands_env_placeholders() {
        unsafe { env::set_var("SECRET_VAL", "hidden") };
        let mut value = JsonValue::String("$ENV{SECRET_VAL}".into());
        resolve_env_placeholders(&mut value).expect("expand env");
        match value {
            JsonValue::String(actual) => assert_eq!(actual, "hidden"),
            _ => panic!("expected string"),
        }
    }

    #[test]
    fn rejects_missing_env() {
        unsafe { env::remove_var("MISSING_SECRET") };
        let mut value = JsonValue::String("$ENV{MISSING_SECRET}".into());
        let err = resolve_env_placeholders(&mut value).unwrap_err();
        match err {
            ConfigError::MissingEnvVar(name) => assert_eq!(name, "MISSING_SECRET"),
            other => panic!("unexpected error: {:?}", other),
        }
    }
}
