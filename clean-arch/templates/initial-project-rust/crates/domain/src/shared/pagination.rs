use serde::Serialize;

const MAX_PAGE_SIZE: u32 = 100;

/// Accepted by List/Search use cases — and only by them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageInput {
    page: u32,
    page_size: u32,
}

impl PageInput {
    /// `page` is 1-based. Out-of-range values are clamped, not rejected.
    pub fn new(page: u32, page_size: u32) -> Self {
        Self {
            page: page.max(1),
            page_size: page_size.clamp(1, MAX_PAGE_SIZE),
        }
    }

    pub const fn page(&self) -> u32 {
        self.page
    }

    pub const fn page_size(&self) -> u32 {
        self.page_size
    }

    pub const fn offset(&self) -> u64 {
        (self.page as u64 - 1) * self.page_size as u64
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOutput<T> {
    pub items: Vec<T>,
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_out_of_range_values() {
        let page = PageInput::new(0, 5_000);
        assert_eq!((page.page(), page.page_size()), (1, 100));
    }

    #[test]
    fn offset_is_zero_based() {
        assert_eq!(PageInput::new(3, 20).offset(), 40);
    }
}
