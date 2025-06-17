document.addEventListener("DOMContentLoaded", () => {
  // Sample product data
  const products = [
    {
      id: 1,
      name: "Роза",
      category: "flowers",
      price: 500,
      image: "image/image13.png",
      description: "Красивый цветок с яркими лепестками, красивое цветущее растение с яркими, ароматными цветами, широко используемое в декоративном садоводстве и для изготовления духов. Ее цветы бывают различных оттенков и форм, а кусты отличаются густой листвой и колючками."
    },
    {
      id: 2,
      name: "Тюльпан",
      category: "flowers",
      price: 450,
      image: "image/image1.png",
      description: "Яркий тюльпан для украшения дома.Крупный цветок с насыщенными оттенками, часто с пестрыми лепестками и декоративной окраской. Он широко используется в декоративном искусстве и флористике благодаря своей красоте и эффектному внешнему виду."
    },
    {
      id: 3,
      name: "Лилия",
      category: "flowers",
      price: 550,
      image: "image/image2.png",
      description: "Ароматная лилия с белыми лепестками.Красивый цветок с крупными, яркими и ароматными цветами, обычно с длинными листьями и трубчатой формой."
    },
    {
      id: 4,
      name: "Гвоздика",
      category: "flowers",
      price: 480,
      image: "image/image3.png",
      description: "Яркая гвоздика для вашего сада."
    },
    {
      id: 5,
      name: "Нарцисс",
      category: "flowers",
      price: 520,
      image: "image/image4.png",
      description: "Весенний нарцисс с желтыми цветами."
    },
    {
      id: 6,
      name: "Кактус",
      category: "cacti",
      price: 300,
      image: "image/image5.png",
      description: "Кактус, который не требует частого полива."
    },
    {
      id: 7,
      name: "Эхинокактус",
      category: "cacti",
      price: 350,
      image: "image/image6.png",
      description: "Маленький колючий эхинокактус."
    },
    {
      id: 8,
      name: "Опунция",
      category: "cacti",
      price: 400,
      image: "image/image7.png",
      description: "Опунция с яркими цветами."
    },
    {
      id: 9,
      name: "Маммиллярия",
      category: "cacti",
      price: 370,
      image: "image/image8.png",
      description: "Маленький колючий кактус маммиллярия."
    },
    {
      id: 10,
      name: "Фикус",
      category: "indoor-trees",
      price: 1200,
      image: "image/image9.png",
      description: "Комнатное дерево, которое очищает воздух."
    },
    {
      id: 11,
      name: "Драцена",
      category: "indoor-trees",
      price: 1300,
      image: "image/image10.png",
      description: "Элегантное комнатное дерево драцена."
    },
    {
      id: 12,
      name: "Монстера",
      category: "indoor-trees",
      price: 1500,
      image: "image/image11.png",
      description: "Популярное комнатное растение монстера."
    },
    {
      id: 13,
      name: "Пальма",
      category: "indoor-trees",
      price: 1600,
      image: "image/image12.png",
      description: "Тропическая пальма для дома."
    }
  ];

  let cart = JSON.parse(localStorage.getItem("cart")) || [];
  let favorites = JSON.parse(localStorage.getItem("favorites")) || [];

  const productList = document.getElementById("product-list");
  const categoryButtons = document.querySelectorAll(".category-button");
  const openModalBtn = document.getElementById("openModalBtn");
  const productDetailModal = document.getElementById("productDetailModal");
  const productDetailContent = document.getElementById("productDetailContent");
  const closeProductDetail = document.getElementById("closeProductDetail");
  const cartModal = document.getElementById("cartModal");
  const closeCartModal = document.getElementById("closeCartModal");
  const cartItemsContainer = document.getElementById("cartItems");
  const orderForm = document.getElementById("orderForm");

  // Render products based on category filter
  function renderProducts(category = "all") {
    productList.innerHTML = "";
    let filteredProducts = category === "all" ? products : products.filter(p => p.category === category);

    filteredProducts.forEach(product => {
      const productCard = document.createElement("div");
      productCard.className = "product-card";

      productCard.innerHTML = `
        <img src="${product.image}" alt="${product.name}" class="product-image" />
        <h3>${product.name}</h3>
        <p>${product.price} ₽</p>
        <div class="product-actions">
          <button class="btn-favorite" data-id="${product.id}" title="Добавить в избранное">
            ${favorites.includes(product.id) ? "★" : "☆"}
          </button>
          <button class="btn-details" data-id="${product.id}">Подробнее</button>
          <button class="btn-add-cart" data-id="${product.id}">В корзину</button>
        </div>
      `;

      productList.appendChild(productCard);
    });

    // Attach event listeners for buttons
    document.querySelectorAll(".btn-favorite").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.getAttribute("data-id"));
        toggleFavorite(id);
        renderProducts(category);
      });
    });

    document.querySelectorAll(".btn-details").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.getAttribute("data-id"));
        showProductDetails(id);
      });
    });

    document.querySelectorAll(".btn-add-cart").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.getAttribute("data-id"));
        addToCart(id);
      });
    });
  }

  // Toggle favorite status
  function toggleFavorite(id) {
    if (favorites.includes(id)) {
      favorites = favorites.filter(favId => favId !== id);
    } else {
      favorites.push(id);
    }
    localStorage.setItem("favorites", JSON.stringify(favorites));
  }

  // Show product details modal
  function showProductDetails(id) {
    const product = products.find(p => p.id === id);
    if (!product) return;

    productDetailContent.innerHTML = `
      <img src="${product.image}" alt="${product.name}" class="product-detail-image" />
      <h3>${product.name}</h3>
      <p>${product.description}</p>
      <p>Цена: ${product.price} ₽</p>
      <div class="quantity-control">
        <button id="decreaseQty">-</button>
        <input type="number" id="productQty" value="1" min="1" />
        <button id="increaseQty">+</button>
      </div>
      <button id="addToCartFromDetail">Добавить в корзину</button>
    `;

    productDetailModal.classList.remove("hidden");
    productDetailModal.style.display = "block";

    const qtyInput = document.getElementById("productQty");
    document.getElementById("decreaseQty").addEventListener("click", () => {
      if (qtyInput.value > 1) qtyInput.value = parseInt(qtyInput.value) - 1;
    });
    document.getElementById("increaseQty").addEventListener("click", () => {
      qtyInput.value = parseInt(qtyInput.value) + 1;
    });

    document.getElementById("addToCartFromDetail").addEventListener("click", () => {
      addToCart(id, parseInt(qtyInput.value));
      productDetailModal.classList.add("hidden");
      productDetailModal.style.display = "none";
    });
  }

  // Close product detail modal
  closeProductDetail.addEventListener("click", () => {
    productDetailModal.classList.add("hidden");
    productDetailModal.style.display = "none";
  });

  // Add product to cart
  function addToCart(id, quantity = 1) {
    const existingItem = cart.find(item => item.id === id);
    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      cart.push({ id, quantity });
    }
    localStorage.setItem("cart", JSON.stringify(cart));
    updateCartCount();
  }

  // Update cart count on button
  function updateCartCount() {
    const totalCount = cart.reduce((sum, item) => sum + item.quantity, 0);
    const cartBtn = document.getElementById("headerCartBtn");
    if (cartBtn) {
      cartBtn.textContent = `Корзина (${totalCount})`;
    }
  }



  // Button in header to open cart modal
  const openCartBtn = document.getElementById("headerCartBtn");
  openCartBtn.addEventListener("click", () => {
    renderCartItems();
    cartModal.classList.remove("hidden");
    cartModal.style.display = "block";
  });

  // Close cart modal when clicking inside the modal content area
  cartModal.addEventListener("click", (event) => {
    if (event.target === cartModal) {
      cartModal.classList.add("hidden");
      cartModal.style.display = "none";
    }
  });

  // Удаляем весь код, связанный с модальным окном пользователя в shop.js

  // Button to open user modal and show user info
  // const openUserBtn = document.getElementById("openModalBtn");
  // const userModal = document.getElementById("userModal");
  // const closeUserModal = document.getElementById("closeUserModal");
  // const userNameDisplay = document.getElementById("userNameDisplay");
  // const userEmailDisplay = document.getElementById("userEmailDisplay");
  // const userOrdersList = document.getElementById("userOrdersList");
  // const userStatusDisplay = document.getElementById("userStatusDisplay");

  // openUserBtn.addEventListener("click", () => {
  //   // For demo, use dummy user data or fetch from localStorage/session
  //   const username = localStorage.getItem("username") || "Пользователь";
  //   const email = localStorage.getItem("email") || "user@example.com";
  //   const orders = JSON.parse(localStorage.getItem("orders")) || [
  //     { id: 1, item: "Роза", status: "Доставлен" },
  //     { id: 2, item: "Кактус", status: "В обработке" }
  //   ];
  //   const status = "Активен";

  //   userNameDisplay.textContent = username;
  //   userEmailDisplay.textContent = email;
  //   userStatusDisplay.textContent = status;

  //   // Clear previous orders
  //   userOrdersList.innerHTML = "";
  //   orders.forEach(order => {
  //     const li = document.createElement("li");
  //     li.textContent = `Заказ #${order.id}: ${order.item} - ${order.status}`;
  //     userOrdersList.appendChild(li);
  //   });

  //   userModal.classList.remove("hidden");
  //   userModal.style.display = "block";
  // });

  // closeUserModal.addEventListener("click", () => {
  //   userModal.classList.add("hidden");
  //   userModal.style.display = "none";
  // });

  // Close cart modal
  closeCartModal.addEventListener("click", () => {
    cartModal.classList.add("hidden");
    cartModal.style.display = "none";
  });

  // Render cart items
  function renderCartItems() {
    cartItemsContainer.innerHTML = "";
    if (cart.length === 0) {
      cartItemsContainer.innerHTML = "<p>Корзина пуста</p>";
      return;
    }

    cart.forEach(item => {
      const product = products.find(p => p.id === item.id);
      if (!product) return;

      const cartItem = document.createElement("div");
      cartItem.className = "cart-item";

      cartItem.innerHTML = `
        <img src="${product.image}" alt="${product.name}" class="cart-item-image" />
        <div class="cart-item-info">
          <h4>${product.name}</h4>
          <p>Цена: ${product.price} ₽</p>
          <div class="quantity-control">
            <button class="decrease-qty" data-id="${item.id}">-</button>
            <input type="number" class="item-qty" data-id="${item.id}" value="${item.quantity}" min="1" />
            <button class="increase-qty" data-id="${item.id}">+</button>
          </div>
          <button class="remove-item" data-id="${item.id}">Удалить</button>
        </div>
      `;

      cartItemsContainer.appendChild(cartItem);
    });

    // Attach event listeners for quantity controls and remove buttons
    document.querySelectorAll(".decrease-qty").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.getAttribute("data-id"));
        changeQuantity(id, -1);
      });
    });

    document.querySelectorAll(".increase-qty").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.getAttribute("data-id"));
        changeQuantity(id, 1);
      });
    });

    document.querySelectorAll(".item-qty").forEach(input => {
      input.addEventListener("change", () => {
        const id = parseInt(input.getAttribute("data-id"));
        const value = parseInt(input.value);
        if (value > 0) {
          setQuantity(id, value);
        } else {
          setQuantity(id, 1);
          input.value = 1;
        }
      });
    });

    document.querySelectorAll(".remove-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.getAttribute("data-id"));
        removeFromCart(id);
      });
    });
  }

  // Change quantity by delta
  function changeQuantity(id, delta) {
    const item = cart.find(i => i.id === id);
    if (!item) return;
    item.quantity += delta;
    if (item.quantity < 1) item.quantity = 1;
    localStorage.setItem("cart", JSON.stringify(cart));
    renderCartItems();
    updateCartCount();
  }

  // Set quantity directly
  function setQuantity(id, quantity) {
    const item = cart.find(i => i.id === id);
    if (!item) return;
    item.quantity = quantity;
    localStorage.setItem("cart", JSON.stringify(cart));
    renderCartItems();
    updateCartCount();
  }

  // Remove item from cart
  function removeFromCart(id) {
    cart = cart.filter(i => i.id !== id);
    localStorage.setItem("cart", JSON.stringify(cart));
    renderCartItems();
    updateCartCount();
  }

  // Handle order form submission
  orderForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (cart.length === 0) {
      alert("Корзина пуста. Добавьте товары перед оформлением заказа.");
      return;
    }

    const orderData = {
      name: orderForm.orderName.value,
      // email: orderForm.orderEmail.value, // Убрано, так как поле email удалено из формы
      address: orderForm.orderAddress.value,
      items: cart.map(item => {
        const product = products.find(p => p.id === item.id);
        return {
          id: item.id,
          name: product ? product.name : "",
          quantity: item.quantity,
          price: product ? product.price : 0
        };
      })
    };

    console.log("Order submitted:", orderData);
    alert("Спасибо за заказ! Мы свяжемся с вами в ближайшее время.");

    // Clear cart and form
    cart = [];
    localStorage.removeItem("cart");
    renderCartItems();
    updateCartCount();
    orderForm.reset();
    cartModal.classList.add("hidden");
    cartModal.style.display = "none";
  });

  // Category filter buttons
  categoryButtons.forEach(button => {
    button.addEventListener("click", () => {
      categoryButtons.forEach(btn => btn.classList.remove("active"));
      button.classList.add("active");
      const category = button.getAttribute("data-category");
      renderProducts(category);
    });
  });

  // Initial render
  renderProducts();
  updateCartCount();
});
