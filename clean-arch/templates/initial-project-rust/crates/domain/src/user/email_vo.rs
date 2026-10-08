use super::errors::UserError;

const MAX_LEN: usize = 254;

/// Self-validating: an `Email` that exists is a valid email.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Email(String);

impl Email {
    pub fn create(raw: &str) -> Result<Self, UserError> {
        let value = raw.trim().to_lowercase();
        if !Self::is_valid(&value) {
            return Err(UserError::InvalidEmail(raw.to_owned()));
        }
        Ok(Self(value))
    }

    /// Skips validation. Only for rehydration from a trusted source (the database).
    pub fn from_trusted(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn is_valid(value: &str) -> bool {
        let Some((local, domain)) = value.split_once('@') else {
            return false;
        };
        value.len() <= MAX_LEN
            && !local.is_empty()
            && !value.contains(char::is_whitespace)
            && domain.contains('.')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
            && !domain.contains('@')
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_case_and_whitespace() {
        let email = Email::create("  Ada@Example.COM ").unwrap();
        assert_eq!(email.as_str(), "ada@example.com");
    }

    #[test]
    fn rejects_malformed_addresses() {
        for raw in ["", "ada", "@example.com", "ada@example", "a b@example.com"] {
            assert!(Email::create(raw).is_err(), "{raw:?} should be rejected");
        }
    }
}
