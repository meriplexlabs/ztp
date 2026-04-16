package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

type CustomerHandler struct {
	pool *pgxpool.Pool
}

func NewCustomerHandler(pool *pgxpool.Pool) *CustomerHandler {
	return &CustomerHandler{pool: pool}
}

func (h *CustomerHandler) List(w http.ResponseWriter, r *http.Request) {
	customers, err := dbpkg.ListCustomers(r.Context(), h.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, customers)
}

func (h *CustomerHandler) Create(w http.ResponseWriter, r *http.Request) {
	var c models.Customer
	if err := decodeJSON(r, &c); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if c.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if err := dbpkg.CreateCustomer(r.Context(), h.pool, &c); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create customer: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (h *CustomerHandler) Update(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid customer ID")
		return
	}
	var c models.Customer
	if err := decodeJSON(r, &c); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	c.ID = id
	if err := dbpkg.UpdateCustomer(r.Context(), h.pool, &c); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update customer: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *CustomerHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid customer ID")
		return
	}
	if err := dbpkg.DeleteCustomer(r.Context(), h.pool, id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete customer: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
